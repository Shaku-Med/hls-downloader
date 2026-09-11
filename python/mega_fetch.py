"""
Download public mega.nz / mega.co.nz file and folder links.

yt-dlp has no Mega extractor. Public links already include the decryption key
in the URL (the # fragment), so the helper talks to Mega's public API the same
way the website does.
"""

from __future__ import annotations

import base64
import json
import os
import re
import struct
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

MEGA_API = "https://g.api.mega.co.nz/cs"
_HOSTS = ("mega.nz", "mega.co.nz")
_FILE_PATH = re.compile(r"^/(?:file|embed)/([^/#?]+)", re.I)
_FOLDER_PATH = re.compile(r"^/folder/([^/#?]+)", re.I)
_OLD_FILE = re.compile(r"^!([0-9A-Za-z_-]{8,})!([0-9A-Za-z_-]{16,})$")
_OLD_FOLDER = re.compile(r"^F!([0-9A-Za-z_-]{8,})!([0-9A-Za-z_-]{16,})$")

ProgressFn = Callable[[Dict[str, Any]], None]


class MegaError(Exception):
    pass


@dataclass
class MegaLink:
    kind: str  # "file" | "folder"
    handle: str
    key: str
    url: str


def _host_of(url: str) -> str:
    try:
        h = (urlparse(url).hostname or "").lower()
    except Exception:
        return ""
    if h.startswith("www."):
        h = h[4:]
    return h


def is_mega_host(url: str) -> bool:
    h = _host_of(url)
    return bool(h) and any(h == d or h.endswith("." + d) for d in _HOSTS)


def parse_mega_url(url: str) -> Optional[MegaLink]:
    raw = (url or "").strip()
    if not raw or not is_mega_host(raw):
        return None
    try:
        parsed = urlparse(raw)
    except Exception:
        return None
    path = unquote(parsed.path or "/")
    frag = unquote((parsed.fragment or "").lstrip("#"))
    m = _FILE_PATH.match(path)
    if m and frag:
        return MegaLink("file", m.group(1), frag, raw)
    m = _FOLDER_PATH.match(path)
    if m and frag:
        return MegaLink("folder", m.group(1), frag, raw)
    m = _OLD_FOLDER.match(frag)
    if m:
        return MegaLink("folder", m.group(1), m.group(2), raw)
    m = _OLD_FILE.match(frag)
    if m:
        return MegaLink("file", m.group(1), m.group(2), raw)
    return None


def is_mega_public_url(url: str) -> bool:
    return parse_mega_url(url) is not None


def pick_mega_url(*candidates: str) -> str:
    for raw in candidates:
        if parse_mega_url(raw or ""):
            return (raw or "").strip()
    return ""


def _b64_decode(data: str) -> bytes:
    s = (data or "").strip().replace("-", "+").replace("_", "/")
    s += "=" * ((4 - len(s) % 4) % 4)
    return base64.b64decode(s)


def _str_to_a32(data: bytes) -> List[int]:
    if len(data) % 4:
        data = data + b"\0" * (4 - len(data) % 4)
    return list(struct.unpack(">" + "I" * (len(data) // 4), data))


def _a32_to_str(values: List[int]) -> bytes:
    return struct.pack(">" + "I" * len(values), *values)


def _base64_to_a32(data: str) -> List[int]:
    return _str_to_a32(_b64_decode(data))


class _AesCbc:
    def __init__(self, key: bytes):
        self._key = key
        self._impl = self._pick()

    def _pick(self):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

            def dec(data: bytes) -> bytes:
                d = Cipher(algorithms.AES(self._key), modes.CBC(b"\0" * 16)).decryptor()
                return d.update(data) + d.finalize()

            return dec
        except ImportError:
            pass
        try:
            from Crypto.Cipher import AES

            def dec(data: bytes) -> bytes:
                return AES.new(self._key, AES.MODE_CBC, b"\0" * 16).decrypt(data)

            return dec
        except ImportError as e:
            raise MegaError(
                "MEGA downloads need the cryptography package. "
                f'Install with: python -m pip install -U cryptography ({e})'
            ) from e

    def decrypt(self, data: bytes) -> bytes:
        if len(data) % 16:
            data = data + b"\0" * (16 - len(data) % 16)
        return self._impl(data)


class _AesCtr:
    def __init__(self, key: bytes, counter_block: bytes):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

            self._d = Cipher(algorithms.AES(key), modes.CTR(counter_block)).decryptor()
            self._mode = "cryptography"
            return
        except ImportError:
            pass
        try:
            from Crypto.Cipher import AES
            from Crypto.Util import Counter

            n = int.from_bytes(counter_block, "big")
            self._d = AES.new(key, AES.MODE_CTR, counter=Counter.new(128, initial_value=n))
            self._mode = "crypto"
            return
        except ImportError as e:
            raise MegaError(
                "MEGA downloads need the cryptography package. "
                f'Install with: python -m pip install -U cryptography ({e})'
            ) from e

    def decrypt(self, data: bytes) -> bytes:
        if self._mode == "cryptography":
            return self._d.update(data)
        return self._d.decrypt(data)


def _require_aes() -> None:
    _AesCbc(b"\0" * 16)


def _decrypt_key(enc: List[int], key: List[int]) -> List[int]:
    raw = _AesCbc(_a32_to_str(key)).decrypt(_a32_to_str(enc))
    return _str_to_a32(raw)


def _file_aes_key(full_key: List[int]) -> List[int]:
    if len(full_key) < 8:
        raise MegaError("MEGA file key is the wrong length")
    return [
        full_key[0] ^ full_key[4],
        full_key[1] ^ full_key[5],
        full_key[2] ^ full_key[6],
        full_key[3] ^ full_key[7],
    ]


def _decrypt_attr(enc_attr: str, aes_key: List[int]) -> Dict[str, Any]:
    data = _b64_decode(enc_attr)
    dec = _AesCbc(_a32_to_str(aes_key)).decrypt(data)
    if not dec.startswith(b"MEGA"):
        raise MegaError(
            "Could not read this MEGA link. Open the page so the # key is in "
            "the address bar, then download again."
        )
    payload = dec[4:].split(b"\0", 1)[0]
    try:
        out = json.loads(payload.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        raise MegaError(f"MEGA file name was unreadable: {e}") from e
    if not isinstance(out, dict):
        raise MegaError("MEGA file attributes were not an object")
    return out


def _api(payload: Any, *, node: str = "") -> Any:
    url = MEGA_API
    if node:
        url += "?n=" + node
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise MegaError(f"Could not reach MEGA: {e}") from e
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        raise MegaError(f"MEGA sent a bad reply: {e}") from e
    if isinstance(data, int) and data < 0:
        raise MegaError(f"MEGA refused the link (error {data})")
    if isinstance(data, list) and data and isinstance(data[0], int) and data[0] < 0:
        raise MegaError(f"MEGA refused the link (error {data[0]})")
    return data


def _sanitize_name(name: str, fallback: str = "mega-file") -> str:
    s = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", (name or "").strip())
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", s).strip(" .")
    return s or fallback


def _unique_path(path: str) -> str:
    if not os.path.isfile(path):
        return path
    root, ext = os.path.splitext(path)
    for n in range(1, 10000):
        cand = f"{root} ({n}){ext}"
        if not os.path.isfile(cand):
            return cand
    return path


def _file_get(handle: str, *, folder: str = "") -> Dict[str, Any]:
    spec: Dict[str, Any] = {"a": "g", "g": 1}
    if folder:
        spec["n"] = handle
        data = _api([spec], node=folder)
    else:
        spec["p"] = handle
        data = _api([spec])
    row = data[0] if isinstance(data, list) else data
    if not isinstance(row, dict):
        raise MegaError("MEGA did not return file info")
    if not row.get("g"):
        raise MegaError("MEGA did not give a download URL for this file")
    return row


def _download_encrypted(
    url: str,
    dest: str,
    full_key: List[int],
    size: int,
    *,
    cancel_check: Callable[[], bool],
    on_progress: Optional[ProgressFn],
    label: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    aes_key = _a32_to_str(_file_aes_key(full_key))
    counter = _a32_to_str([full_key[4], full_key[5], 0, 0])
    cipher = _AesCtr(aes_key, counter)
    req = urllib.request.Request(url, method="GET", headers={"Accept": "*/*"})
    written = 0
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)
    tmp = dest + ".part"
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as fh:
            while True:
                if cancel_check():
                    raise MegaError("Canceled")
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                fh.write(cipher.decrypt(chunk))
                written += len(chunk)
                if on_progress and size > 0:
                    pct = min(100.0, 100.0 * written / size)
                    patch = {
                        "percent": pct,
                        "detail": f"{label} · {written // 1024} / {size // 1024} KB",
                        "output": dest,
                    }
                    if extra:
                        patch.update(extra)
                    on_progress(patch)
        if os.path.isfile(dest):
            try:
                os.remove(dest)
            except OSError:
                pass
        os.replace(tmp, dest)
    except MegaError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise MegaError(f"MEGA download failed: {e}") from e


def _download_public_file(
    link: MegaLink,
    dest: str,
    *,
    cancel_check: Callable[[], bool],
    on_progress: Optional[ProgressFn],
    filename_hint: str,
) -> str:
    info = _file_get(link.handle)
    full_key = _base64_to_a32(link.key)
    if len(full_key) < 8:
        raise MegaError("This MEGA file link is missing its key")
    aes_key = _file_aes_key(full_key)
    meta = _decrypt_attr(str(info.get("at") or ""), aes_key)
    name = _sanitize_name(str(meta.get("n") or ""), filename_hint or "mega-file")
    size = int(info.get("s") or 0)
    folder = os.path.dirname(os.path.abspath(dest))
    path = dest
    if os.path.isdir(dest) or dest.endswith(("/", "\\")):
        path = os.path.join(dest, name)
    elif not os.path.splitext(os.path.basename(dest))[1]:
        path = os.path.join(folder, name)
    else:
        # Keep the user's folder, take MEGA's real name when the stem is generic.
        if filename_hint.lower() in {"mega", "video", "file", "download", "stream"}:
            path = os.path.join(folder, name)
    path = _unique_path(path)
    if on_progress:
        on_progress({"percent": 0, "detail": f"MEGA · {name}", "output": path})
    _download_encrypted(
        str(info["g"]),
        path,
        full_key,
        size,
        cancel_check=cancel_check,
        on_progress=on_progress,
        label=name,
    )
    return path


def _folder_nodes(link: MegaLink) -> Tuple[List[Dict[str, Any]], List[int]]:
    folder_key = _base64_to_a32(link.key)
    if len(folder_key) < 4:
        raise MegaError("This MEGA folder link is missing its key")
    folder_key = folder_key[:4]
    data = _api([{"a": "f", "c": 1, "r": 1}], node=link.handle)
    nodes = data.get("f") if isinstance(data, dict) else None
    if not isinstance(nodes, list):
        raise MegaError("MEGA did not list the folder")
    return nodes, folder_key


def _node_key(node: Dict[str, Any], folder_key: List[int]) -> Optional[List[int]]:
    raw = str(node.get("k") or "")
    if ":" not in raw:
        return None
    enc = raw.split(":", 1)[1]
    try:
        return _decrypt_key(_base64_to_a32(enc), folder_key)
    except (MegaError, ValueError, struct.error):
        return None


def _node_path(
    node: Dict[str, Any],
    by_handle: Dict[str, Dict[str, Any]],
    names: Dict[str, str],
    root: str,
) -> str:
    parts: List[str] = []
    cur = node
    guard = 0
    while cur and guard < 64:
        guard += 1
        h = str(cur.get("h") or "")
        parent = str(cur.get("p") or "")
        if h == root or parent == root:
            name = names.get(h) or ""
            if name and int(cur.get("t") or 0) == 0:
                parts.append(name)
            break
        name = names.get(h) or ""
        if name:
            parts.append(name)
        cur = by_handle.get(parent)
        if not cur:
            break
    parts.reverse()
    return os.path.join(*parts) if parts else (names.get(str(node.get("h") or "")) or "file")


def _download_public_folder(
    link: MegaLink,
    out_dir: str,
    *,
    cancel_check: Callable[[], bool],
    on_progress: Optional[ProgressFn],
    filename_hint: str,
) -> str:
    nodes, folder_key = _folder_nodes(link)
    by_handle = {str(n.get("h") or ""): n for n in nodes if n.get("h")}
    names: Dict[str, str] = {}
    files: List[Tuple[Dict[str, Any], List[int]]] = []
    folder_name = _sanitize_name(filename_hint, "mega-folder")
    for node in nodes:
        key = _node_key(node, folder_key)
        if not key:
            continue
        typ = int(node.get("t") or -1)
        if typ == 1:
            aes = key[:4]
        elif typ == 0:
            if len(key) < 8:
                continue
            aes = _file_aes_key(key)
        else:
            continue
        try:
            meta = _decrypt_attr(str(node.get("a") or ""), aes)
        except MegaError:
            continue
        name = _sanitize_name(str(meta.get("n") or ""), "item")
        names[str(node.get("h") or "")] = name
        if typ == 1 and str(node.get("h") or "") == link.handle:
            folder_name = name
        if typ == 0:
            files.append((node, key))

    if not files:
        raise MegaError("This MEGA folder has no downloadable files")

    dest_root = os.path.join(out_dir, folder_name)
    os.makedirs(dest_root, exist_ok=True)
    total = len(files)
    last_path = dest_root
    for i, (node, key) in enumerate(files, start=1):
        if cancel_check():
            raise MegaError("Canceled")
        rel = _node_path(node, by_handle, names, link.handle)
        dest = _unique_path(os.path.join(dest_root, rel))
        info = _file_get(str(node.get("h") or ""), folder=link.handle)
        size = int(info.get("s") or node.get("s") or 0)
        extra = {"playlistIndex": i, "playlistCount": total}
        if on_progress:
            on_progress(
                {
                    "percent": 100.0 * (i - 1) / total,
                    "detail": f"MEGA {i}/{total} · {os.path.basename(dest)}",
                    "output": dest,
                    **extra,
                }
            )
        _download_encrypted(
            str(info["g"]),
            dest,
            key,
            size,
            cancel_check=cancel_check,
            on_progress=on_progress,
            label=f"{i}/{total} {os.path.basename(dest)}",
            extra=extra,
        )
        last_path = dest
    return dest_root if total > 1 else last_path


def download_mega(
    url: str,
    out_dir: str,
    filename_hint: str = "mega-file",
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
    on_progress: Optional[ProgressFn] = None,
) -> str:
    """
    Download a public MEGA file or folder. Returns the file path, or the folder
    path when more than one file was saved.
    """
    _require_aes()
    link = parse_mega_url(url)
    if not link:
        raise MegaError(
            "Not a MEGA file or folder link. The # key has to stay on the URL."
        )
    os.makedirs(out_dir, exist_ok=True)
    check = cancel_check or (lambda: False)
    hint = _sanitize_name(filename_hint, "mega-file")
    if link.kind == "folder":
        return _download_public_folder(
            link,
            out_dir,
            cancel_check=check,
            on_progress=on_progress,
            filename_hint=hint,
        )
    dest = os.path.join(out_dir, hint)
    return _download_public_file(
        link,
        dest,
        cancel_check=check,
        on_progress=on_progress,
        filename_hint=hint,
    )
