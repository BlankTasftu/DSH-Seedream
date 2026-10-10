#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""火山引擎 Signature V4 参考实现（用于交叉验证 JS 侧 lib/billing.js）。

算法逐行对齐官方 Python SDK 的 `volcenginesdkcore/signv4.py`（SignerV4.sign），
唯一改动是把 `datetime.utcnow()` 换成可注入的固定时间，以便做确定性对比。

用法：
    echo '{"accessKey":"...","secretKey":"...","host":"...","path":"/","method":"POST",
           "query":{"Action":"QueryBalanceAcct","Version":"2022-01-01"},"body":"{}",
           "contentType":"application/json; charset=utf-8","region":"cn-north-1",
           "service":"billing","xDate":"20261010T080000Z"}' | python signv4_reference.py
输出：JSON（Authorization / X-Date / X-Content-Sha256 / CanonicalRequest）
"""
import hashlib
import hmac
import json
import sys
from urllib.parse import quote

# 与官方 SDK 一致的默认值
DEFAULT_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8"


def canonical_query(query):
    res = []
    for key in query:
        value = str(query[key])
        res.append((quote(key, safe="-_.~"), quote(value, safe="-_.~")))
    sorted_key_vals = []
    for key, value in sorted(res):
        sorted_key_vals.append("%s=%s" % (key, value))
    return "&".join(sorted_key_vals)


def hmac_sha256(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def get_signing_secret_key_v4(sk, date, region, service):
    kdate = hmac_sha256(sk.encode("utf-8"), date)
    kregion = hmac_sha256(kdate, region)
    kservice = hmac_sha256(kregion, service)
    return hmac_sha256(kservice, "request")


def sign(path, method, headers, body, query, ak, sk, region, service, format_date):
    """对应官方 SignerV4.sign（时间改为外部注入）。"""
    if path == "":
        path = "/"
    if method != "GET" and "Content-Type" not in headers:
        headers["Content-Type"] = DEFAULT_CONTENT_TYPE
    headers["X-Date"] = format_date

    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    headers["X-Content-Sha256"] = body_hash

    signed_headers = {}
    for key in headers:
        if key in ["Content-Type", "Content-Md5", "Host"] or key.startswith("X-"):
            signed_headers[key.lower()] = headers[key]

    if "host" in signed_headers:
        v = signed_headers["host"]
        if v.find(":") != -1:
            split = v.split(":")
            port = split[1]
            if str(port) == "80" or str(port) == "443":
                signed_headers["host"] = split[0]

    signed_str = ""
    for key in sorted(signed_headers.keys()):
        signed_str += key + ":" + signed_headers[key] + "\n"

    signed_headers_string = ";".join(sorted(signed_headers.keys()))

    canonical_request = "\n".join(
        [method, path, canonical_query(dict(query)), signed_str, signed_headers_string, body_hash]
    )
    credential_scope = "/".join([format_date[:8], region, service, "request"])
    signing_str = "\n".join(
        ["HMAC-SHA256", format_date, credential_scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()]
    )
    signing_key = get_signing_secret_key_v4(sk, format_date[:8], region, service)
    signature = hmac.new(signing_key, signing_str.encode("utf-8"), hashlib.sha256).hexdigest()
    credential = ak + "/" + credential_scope
    headers["Authorization"] = (
        "HMAC-SHA256"
        + " Credential="
        + credential
        + ", SignedHeaders="
        + signed_headers_string
        + ", Signature="
        + signature
    )
    headers["CanonicalRequest"] = canonical_request
    return headers


def main():
    spec = json.loads(sys.stdin.read())
    headers = {
        "Content-Type": spec.get("contentType", "application/json; charset=utf-8"),
        "Host": spec["host"],
    }
    signed = sign(
        spec.get("path", "/"),
        spec.get("method", "POST").upper(),
        headers,
        spec.get("body", "{}"),
        spec.get("query", {}),
        spec["accessKey"],
        spec["secretKey"],
        spec["region"],
        spec["service"],
        spec["xDate"],
    )
    print(
        json.dumps(
            {
                "Authorization": signed["Authorization"],
                "X-Date": signed["X-Date"],
                "X-Content-Sha256": signed["X-Content-Sha256"],
                "CanonicalRequest": signed["CanonicalRequest"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
