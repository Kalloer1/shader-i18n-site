#!/usr/bin/env bash
# 安装夸克网盘 CLI（quark-drive.cjs）到技能目录。translate.yml 与 quark-smoke.yml 共用本脚本，
# 保证两处安装逻辑不会各写一份而漂移。
#
# 为什么每次都要重新装：quark-drive.cjs 是 620KB 自包含单文件，超过 GitHub secret 的 48KB 上限，
# 也不能提交进仓库（SKILL.md 禁止读取/分析其源码，且它随服务端版本自更新）。
# 所以只能按官方安装方式，从服务端接口取 zip 地址下载解压。
#
# 安装位置（与 SKILL.md 的目录约定一致）：
#   $HOME/.pi/agent/skills/quarkclouddrive/scripts/quark-drive.cjs
#
# 容错：网络失败 / 接口变更 / 解压失败时只打印 ::warning:: 并 exit 0，
# 绝不因此让调用方 workflow 变红 —— 镜像失败只让网盘字段留空，不该卡住翻译发布。
# 但必须留下可见痕迹（::warning:: 会在 run 摘要里渲染），不能静默。

set -uo pipefail

SKILL_DIR="${QUARK_SKILL_DIR:-$HOME/.pi/agent/skills/quarkclouddrive}"
CLI="$SKILL_DIR/scripts/quark-drive.cjs"
API="https://open-api-drive.quark.cn/agent/v1/skill_config"

warn() {
  echo "::warning::夸克 CLI 安装失败：$1 —— 调用方应跳过夸克镜像（网盘字段留空），不影响翻译发布。"
  exit 0
}

mkdir -p "$SKILL_DIR/scripts"

echo "请求 $API …"
CFG=$(curl -fsSL --connect-timeout 30 --max-time 60 "${API}?req_id=$(date +%s)${RANDOM}") \
  || warn "请求 skill_config 接口失败"

# 兼容多层结构：{data:{config}} / {config} / {data} / 裸对象（当前服务端返回 {status,errno,data:{config}}）
URL=$(printf '%s' "$CFG" | node -e '
let s = ""
process.stdin.on("data", (d) => { s += d })
process.stdin.on("end", () => {
  let j
  try { j = JSON.parse(s) } catch { process.exit(1) }
  const cfg = (j && j.data && j.data.config) || (j && j.config) || (j && j.data) || j || {}
  const url = String(cfg.qkPan || "").trim()
  if (!url) process.exit(2)
  process.stdout.write(url)
})
') || warn "skill_config 未返回有效的 zip 下载地址"

echo "zip 地址：$URL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL --connect-timeout 30 --max-time 180 -o "$TMP/skill.zip" "$URL" \
  || warn "下载 zip 失败：$URL"
unzip -qo "$TMP/skill.zip" -d "$TMP/unpacked" || warn "解压 zip 失败：$URL"

SRC="$(find "$TMP/unpacked" -type d -name scripts -print -quit)"
[ -n "$SRC" ] || warn "zip 包内未找到 scripts 目录"
cp -rf "$SRC/." "$SKILL_DIR/scripts/"

[ -f "$CLI" ] || warn "安装后仍找不到 $CLI"

echo "夸克 CLI 安装成功：$CLI（$(wc -c < "$CLI" | tr -d ' ') 字节）"
