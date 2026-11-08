#!/usr/bin/env bash
# 一键打包 dsh-agent-session-tools，产出可 `dsh plugin add` 的 tgz。
# pack.ps1 的 bash 复刻，选项一一对应：
#   --out-dir DIR   输出目录（默认 release）
#   --skip-tests    跳过测试
#   --keep-out-dir  保留输出目录里的旧文件（默认先清空）
#
# 步骤：检查 Node.js 版本 → build.mjs 构建（自动垫 node_modules）→ vitest →
# npm pack 到输出目录 → 校验 tarball 只含运行文件 → 写 SHA256SUMS.txt。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_dir="release"
skip_tests=false
keep_out_dir=false

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --out-dir=*) out_dir="${1#*=}"; shift ;;
    --skip-tests) skip_tests=true; shift ;;
    --keep-out-dir) keep_out_dir=true; shift ;;
    *) echo "未知参数：$1（可用 --out-dir DIR / --skip-tests / --keep-out-dir）" >&2; exit 2 ;;
  esac
done

step() {
  local label="$1"; shift
  echo "==> $label"
  "$@"
}

# ── Node.js >= 22.19.0（package.json engines 口径）───────────────────────────
if ! command -v node > /dev/null 2>&1; then
  echo "未找到 Node.js，请安装 Node.js >= 22.19.0。" >&2
  exit 1
fi
node_version="$(node --version)"
if ! [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "无法解析 Node.js 版本：$node_version" >&2
  exit 1
fi
major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 19 ]; }; then
  echo "需要 Node.js >= 22.19.0，当前为 $node_version。" >&2
  exit 1
fi
echo "==> $(node -p "require('$root/package.json').name") pack"
echo "    version: $(node -p "require('$root/package.json').version")"
echo "    node: $node_version"

cd "$root"

# ── 构建 ─────────────────────────────────────────────────────────────────────
step "build (tsc -p tsconfig.build.json)" node scripts/build.mjs tsconfig.build.json

# ── 测试 ─────────────────────────────────────────────────────────────────────
if [ "$skip_tests" = false ]; then
  # build.mjs 会在垫片里留下一个探测过可运行的 vitest；垫片缺失时退回 npx。
  vitest="$root/node_modules/.bin/vitest"
  if [ -x "$vitest" ]; then
    step "test (vitest run)" "$vitest" run --config vitest.config.ts
  else
    step "test (npx vitest run)" npx vitest run --config vitest.config.ts
  fi
fi

# ── 输出目录 ─────────────────────────────────────────────────────────────────
if [ -d "$out_dir" ] && [ "$keep_out_dir" = false ]; then
  rm -rf "$out_dir"
fi
mkdir -p "$out_dir"

# ── npm pack ─────────────────────────────────────────────────────────────────
pack_output="$(step "npm pack" npm pack --ignore-scripts --pack-destination "$out_dir")"
tgz_name="$(printf '%s\n' "$pack_output" | grep -E '\.tgz$' | tail -n 1)"
if [ -z "$tgz_name" ]; then
  echo "npm pack 未返回 tarball 文件名。" >&2
  exit 1
fi
tgz="$out_dir/$tgz_name"
if [ ! -f "$tgz" ]; then
  echo "tarball 不存在：$tgz" >&2
  exit 1
fi

# ── 校验 tarball 内容 ────────────────────────────────────────────────────────
step "校验 tarball 内容" true
entries="$(tar -tzf "$tgz")"
for item in package/package.json package/cordis.patch.yml package/cordis.yml; do
  if ! grep -qxF "$item" <<< "$entries"; then
    echo "tarball 缺少 $item。" >&2
    exit 1
  fi
done
for item in package/dist/index.js package/dist/session-tools.js package/dist/checks.js; do
  if ! grep -qxF "$item" <<< "$entries"; then
    echo "tarball 缺少 $item，构建可能失败。" >&2
    exit 1
  fi
done
forbidden="$(grep -E '^package/(src|tests|scripts|node_modules|release)/' <<< "$entries" || true)"
if [ -n "$forbidden" ]; then
  echo "tarball 含不应发布的路径：" >&2
  echo "$forbidden" >&2
  exit 1
fi
echo "    entries: $(wc -l <<< "$entries")"

# ── SHA256 ───────────────────────────────────────────────────────────────────
hash="$(sha256sum "$tgz" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$tgz_name" > "$out_dir/SHA256SUMS.txt"

full="$(cd "$(dirname "$tgz")" && pwd)/$(basename "$tgz")"
echo
echo "==> 完成"
echo "    tarball: $full ($(( $(stat -c%s "$tgz") / 1024 )) KB)"
echo "    sha256 : $hash"
echo
echo "安装方式（需重启 DSH）："
echo "    dsh plugin --profile <profile> add $full"
