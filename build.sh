#!/bin/bash
# Block Blue - 打包脚本
# 用于制作 Chrome/Edge 扩展商店发布用的 zip 压缩包

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# 从 manifest.json 读取版本号
VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')
OUTPUT="block-blue-v${VERSION}.zip"

# 需要打包的文件/目录
INCLUDES=(
  manifest.json
  _locales/
  background/
  content/
  icons/
  popup/
)

# 清理旧的构建产物
rm -f "$OUTPUT"

# 检查必要文件是否存在
for item in "${INCLUDES[@]}"; do
  if [[ ! -e "$item" ]]; then
    echo "错误: 缺少必要文件 $item"
    exit 1
  fi
done

# 打包
zip -r "$OUTPUT" "${INCLUDES[@]}" -x "*.DS_Store" "*__MACOSX*"

echo ""
echo "✅ 打包完成: $OUTPUT"
echo "📦 版本: v${VERSION}"
echo ""
# 显示包内容摘要
echo "包含文件:"
unzip -l "$OUTPUT" | awk 'NR>3 && /\// {print "  " $4}' | grep -v '^  $'
echo ""
echo "总大小: $(du -h "$OUTPUT" | cut -f1)"
