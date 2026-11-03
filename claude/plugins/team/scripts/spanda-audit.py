#!/usr/bin/env python3
# Spanda audit: ask a local LM Studio model each claim question K times at
# temperature T and score per-claim self-consistency (risk 0 = unanimous,
# 1 = maximal disagreement). Python 3.12 stdlib only - no pip, no bundle.
# Input (stdin, or --input <path>):
#   {"claims":[{"id","question","context","answer_type":"yes_no"|"short"}]}
# Output: one JSON object on stdout.
# Exit codes: 0 = audit ran ("status":"ok") or LM Studio unreachable
# ("status":"unavailable", "claims":[]); 2 = malformed input JSON. A mid-run
# request failure drops that sample; a claim left with <2 samples reports
# "risk":null plus "error" while overall status stays "ok".
# Env (CLI flags win): CONDUCTOR_AUDIT_BASE_URL (http://127.0.0.1:8080),
# CONDUCTOR_AUDIT_MODEL (empty -> first id from GET {base}/models),
# CONDUCTOR_AUDIT_K (5), CONDUCTOR_AUDIT_TEMPERATURE (0.7),
# CONDUCTOR_AUDIT_TIMEOUT (60, seconds per request).

import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from urllib import request

DEFAULT_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_K = 5
DEFAULT_TEMPERATURE = 0.7
DEFAULT_TIMEOUT = 60.0
PREFLIGHT_TIMEOUT = 3.0
MAX_TOKENS = 16
THRESHOLD = 0.35

_WHITESPACE = re.compile(r"\s+")
_BOXED = re.compile(r"\\boxed\s*\{([^{}]*)\}")
_HEADING = re.compile(r"^#+\s*")
_FILLER = re.compile(r"^(?:the\s+|my\s+|final\s+)*answer(?:\s+is)?\s*[:\-]?\s+")
_YES_NO = re.compile(r"^(yes|no)\b")
_TRIM_CHARS = " \t\"'`*_#.,;:!?()[]{}<>"


def normalize(value, answer_type="short"):
    if not isinstance(value, str):
        return ""
    text = _WHITESPACE.sub(" ", value).strip().lower()
    text = _BOXED.sub(r"\1", text)
    text = text.replace("**", "")
    text = _HEADING.sub("", text)
    for _ in range(3):
        stripped = _FILLER.sub("", text.strip(_TRIM_CHARS), count=1).strip(_TRIM_CHARS).strip()
        if stripped == text:
            break
        text = stripped
    text = _WHITESPACE.sub(" ", text).strip()
    if answer_type == "yes_no":
        match = _YES_NO.match(text)
        if match:
            return match.group(1)
    return text


def _clamp(value):
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def entropy(samples):
    total = len(samples)
    counts = Counter(samples)
    if total < 2 or len(counts) < 2:
        return 0.0
    weights = [count / total for count in counts.values()]
    return _clamp(-math.fsum(w * math.log(w) for w in weights) / math.log(total))


def risk(samples):
    total = len(samples)
    if total < 1:
        return 0.0
    w_max = max(Counter(samples).values()) / total
    return _clamp(0.5 * entropy(samples) + 0.5 * (1.0 - w_max))


def _env_str(name, default):
    value = os.environ.get(name, "").strip()
    return value or default


def _env_number(name, default, cast):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError:
        return default


def _parse_args(argv):
    parser = argparse.ArgumentParser(description="Spanda self-consistency audit against a local LM Studio server.")
    parser.add_argument("--input", default="-")
    parser.add_argument("--k", type=int, default=_env_number("CONDUCTOR_AUDIT_K", DEFAULT_K, int))
    parser.add_argument("--temperature", type=float, default=_env_number("CONDUCTOR_AUDIT_TEMPERATURE", DEFAULT_TEMPERATURE, float))
    parser.add_argument("--timeout", type=float, default=_env_number("CONDUCTOR_AUDIT_TIMEOUT", DEFAULT_TIMEOUT, float))
    parser.add_argument("--base-url", default=_env_str("CONDUCTOR_AUDIT_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--model", default=_env_str("CONDUCTOR_AUDIT_MODEL", ""))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    args.base_url = args.base_url.rstrip("/")
    args.k = max(1, args.k)
    return args


def _die(message):
    print("spanda-audit: " + message, file=sys.stderr)
    raise SystemExit(2)


def _read_claims(path):
    try:
        if path == "-":
            text = sys.stdin.read()
        else:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
    except OSError as exc:
        _die("cannot read input: " + str(exc))
    try:
        payload = json.loads(text)
    except ValueError as exc:
        _die("malformed input JSON: " + str(exc))
    if not isinstance(payload, dict) or not isinstance(payload.get("claims"), list):
        _die('malformed input JSON: expected {"claims": [...]}')
    return [claim for claim in payload["claims"] if isinstance(claim, dict)]


def _get_json(url, timeout):
    req = request.Request(url, headers={"Accept": "application/json"})
    with request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def _post_json(url, payload, timeout):
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def resolve_model(base_url, model):
    try:
        payload = _get_json(base_url + "/models", PREFLIGHT_TIMEOUT)
    except (OSError, ValueError) as exc:
        return None, "LM Studio unreachable at " + base_url + ": " + str(exc)
    entries = payload.get("data") if isinstance(payload, dict) else None
    ids = [item.get("id") for item in entries or [] if isinstance(item, dict) and isinstance(item.get("id"), str)]
    if not ids:
        return None, "no models loaded at " + base_url
    return model or ids[0], None


def _messages(claim, answer_type):
    system = "Answer with only `yes` or `no`." if answer_type == "yes_no" else "Answer in at most 5 words."
    context = str(claim.get("context") or "").strip()
    question = str(claim.get("question") or "").strip()
    user = context + "\n\n" + question if context else question
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _content(payload):
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("response carried no choices")
    message = choices[0].get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("response carried empty content")
    return content


def audit_claim(claim, args, model):
    answer_type = claim.get("answer_type") if claim.get("answer_type") in ("yes_no", "short") else "short"
    body = {
        "model": model,
        "messages": _messages(claim, answer_type),
        "temperature": args.temperature,
        "max_tokens": MAX_TOKENS,
    }
    raw = []
    failures = []
    for _ in range(args.k):
        try:
            raw.append(_content(_post_json(args.base_url + "/chat/completions", body, args.timeout)))
        except (OSError, ValueError) as exc:
            failures.append(str(exc))
    samples = [text for text in (normalize(item, answer_type) for item in raw) if text]
    result = {
        "id": claim.get("id"),
        "risk": None,
        "entropy": None,
        "uncertain": None,
        "majority": None,
        "distribution": {},
        "raw": raw,
    }
    if len(samples) < 2:
        if failures:
            detail = failures[0]
        elif args.k < 2:
            detail = "k is below the 2-sample minimum"
        else:
            detail = "answers normalized to empty strings"
        result["error"] = "%d/%d samples survived: %s" % (len(samples), args.k, detail)
        return result
    score = risk(samples)
    counts = Counter(samples)
    result["risk"] = score
    result["entropy"] = entropy(samples)
    result["uncertain"] = score >= THRESHOLD
    result["majority"] = counts.most_common(1)[0][0]
    result["distribution"] = dict(counts.most_common())
    if failures:
        result["dropped"] = len(failures)
    return result


def self_test():
    distinct = ["alpha", "beta", "gamma", "delta", "epsilon"]
    skewed = ["yes", "yes", "yes", "no"]
    # plain asserts would be stripped under python -O, silencing the whole suite
    checks = [
        (entropy(["yes"] * 5) == 0.0, "entropy(unanimous) is %r, want 0.0" % entropy(["yes"] * 5)),
        (entropy(distinct) == 1.0, "entropy(all distinct) is %r, want 1.0" % entropy(distinct)),
        (abs(risk(distinct) - 0.9) < 1e-9, "risk(all distinct) is %r, want 0.9" % risk(distinct)),
        (risk(["yes"] * 5) == 0.0, "risk(unanimous) is %r, want 0.0" % risk(["yes"] * 5)),
        (normalize("Yes.") == "yes", "normalize('Yes.') is %r" % normalize("Yes.")),
        (normalize("**The answer is 42**") == "42", "normalize(filler + bold) is %r" % normalize("**The answer is 42**")),
        (normalize("Yes, because the loop exits early.", "yes_no") == "yes", "normalize(yes_no prefix) is %r" % normalize("Yes, because the loop exits early.", "yes_no")),
        (normalize("#### \\boxed{No}", "yes_no") == "no", "normalize(heading + boxed) is %r" % normalize("#### \\boxed{No}", "yes_no")),
        (entropy(skewed) < entropy(["yes", "yes", "no", "no"]), "entropy must rise with disagreement"),
        (risk(skewed) < risk(distinct), "risk must rise with disagreement"),
    ]
    for ok, label in checks:
        if not ok:
            raise SystemExit("self-test failed: %s" % label)
    print("self-test: ok")


def main(argv):
    args = _parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    claims = _read_claims(args.input)
    report = {
        "status": "ok",
        "base_url": args.base_url,
        "model": args.model,
        "k": args.k,
        "temperature": args.temperature,
        "threshold": THRESHOLD,
        "claims": [],
    }
    model, reason = resolve_model(args.base_url, args.model)
    if model is None:
        report["status"] = "unavailable"
        report["reason"] = reason
    else:
        report["model"] = model
        report["claims"] = [audit_claim(claim, args, model) for claim in claims]
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
