#!/bin/bash
set -euo pipefail

# Build a separate patched runtime. Never mutate the input runtime or library.
# Usage: bash build-videotoolbox-fix.sh SOURCE_TAR_XZ INPUT_VLC_APP OUTPUT_VLC_APP
[[ $# == 3 ]] || { echo 'Expected source archive, input VLC.app, and new output VLC.app.' >&2; exit 2; }
archive=$1
input=$2
output=$3
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'This build is verified for Apple Silicon macOS only.' >&2; exit 2; }
[[ -f "$archive" && -d "$input" && ! -e "$output" ]] || { echo 'Input files must exist and the output must be new.' >&2; exit 2; }
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$input/Contents/Info.plist")
[[ "$version" == 3.0.23 ]] || { echo 'The input runtime must be VLC 3.0.23.' >&2; exit 2; }
expected=e891cae6aa3ccda69bf94173d5105cbc55c7a7d9b1d21b9b21666e69eff3e7e0
actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
[[ "$actual" == "$expected" ]] || { echo 'Expected the official VLC 3.0.23 source archive.' >&2; exit 2; }
script_dir=$(cd "$(dirname "$0")" && pwd)
build_dir=$(mktemp -d /tmp/loomtv-vlc-vt.XXXXXX)
trap 'rm -rf "$build_dir"' EXIT
tar -xf "$archive" -C "$build_dir"
source_dir="$build_dir/vlc-3.0.23"
patch -d "$source_dir" -p1 < "$script_dir/videotoolbox-hevc-parameter-sets.patch"
cp "$script_dir/videotoolbox-4k-gate.h" "$source_dir/modules/codec/videotoolbox-4k-gate.h"
(
  cd "$source_dir"
  ./configure --disable-plugins --disable-nls --disable-lua --disable-qt \
    --disable-macosx --disable-skins2 --disable-dbus --disable-avcodec \
    --disable-swscale --disable-a52 --disable-mad --disable-libgcrypt \
    --disable-xcb --disable-sout --disable-sparkle > "$build_dir/configure.log" 2>&1 \
    || { tail -20 "$build_dir/configure.log" >&2; exit 1; }
)
objects=()
for source in codec/vt_utils.c codec/videotoolbox.m codec/hxxx_helper.c \
  packetizer/hxxx_nal.c packetizer/hxxx_sei.c packetizer/h264_slice.c \
  packetizer/h264_nal.c packetizer/hevc_nal.c video_chroma/copy.c; do
  object="$build_dir/$(basename "${source%.*}").o"
  clang -c -O2 -fPIC -mmacosx-version-min=11.0 -DHAVE_CONFIG_H -D__PLUGIN__ \
    '-DMODULE_STRING="videotoolbox"' -I"$source_dir" -I"$source_dir/include" \
    -I"$source_dir/modules" "$source_dir/modules/$source" -o "$object"
  objects+=("$object")
done
clang -dynamiclib -mmacosx-version-min=11.0 "${objects[@]}" \
  -L"$input/Contents/MacOS/lib" -lvlccore -framework Foundation \
  -framework VideoToolbox -framework CoreMedia -framework CoreVideo -liconv \
  -o "$build_dir/libvideotoolbox_plugin.dylib"
mkdir -p "$(dirname "$output")"
cp -cR "$input" "$output"
cp "$build_dir/libvideotoolbox_plugin.dylib" "$output/Contents/MacOS/plugins/libvideotoolbox_plugin.dylib"
# Sign the rebuilt library for local loading. Application packaging must sign
# the containing bundle after staging all native runtime files.
codesign --force --sign - "$output/Contents/MacOS/plugins/libvideotoolbox_plugin.dylib"
echo "Patched LibVLC runtime: $output"
