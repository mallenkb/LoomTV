#ifndef LOOMTV_VLC_VIDEOTOOLBOX_4K_GATE_H
#define LOOMTV_VLC_VIDEOTOOLBOX_4K_GATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

static inline bool loomtv_vlc_needs_inband_hevc_sets_4k(
    uint32_t visible_width, uint32_t visible_height,
    uint32_t coded_width, uint32_t coded_height,
    const void *extra, size_t extra_size, bool is_xvcc)
{
    const uint32_t width = visible_width ? visible_width : coded_width;
    const uint32_t height = visible_height ? visible_height : coded_height;
    const bool is_4k = (width >= 3840 && height > 1440) ||
                       (height >= 3840 && width > 1440);
    return is_4k && is_xvcc && extra && extra_size >= 23 &&
           ((const uint8_t *)extra)[22] == 0;
}

#endif
