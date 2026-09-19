#include <assert.h>
#include <stdint.h>
#include "videotoolbox-4k-gate.h"

int main(void)
{
    uint8_t empty_hvcc[23] = {0};
    uint8_t complete_hvcc[23] = {0};
    complete_hvcc[22] = 3;

    assert(loomtv_vlc_needs_inband_hevc_sets_4k(3840, 2160, 0, 0,
                                                empty_hvcc, sizeof empty_hvcc, true));
    assert(loomtv_vlc_needs_inband_hevc_sets_4k(4096, 1716, 0, 0,
                                                empty_hvcc, sizeof empty_hvcc, true));
    assert(loomtv_vlc_needs_inband_hevc_sets_4k(2160, 3840, 0, 0,
                                                empty_hvcc, sizeof empty_hvcc, true));
    assert(loomtv_vlc_needs_inband_hevc_sets_4k(0, 0, 3840, 2160,
                                                empty_hvcc, sizeof empty_hvcc, true));

    assert(!loomtv_vlc_needs_inband_hevc_sets_4k(1920, 1080, 0, 0,
                                                 empty_hvcc, sizeof empty_hvcc, true));
    assert(!loomtv_vlc_needs_inband_hevc_sets_4k(2560, 1440, 0, 0,
                                                 empty_hvcc, sizeof empty_hvcc, true));
    assert(!loomtv_vlc_needs_inband_hevc_sets_4k(3840, 1440, 0, 0,
                                                 empty_hvcc, sizeof empty_hvcc, true));
    assert(!loomtv_vlc_needs_inband_hevc_sets_4k(3840, 2160, 0, 0,
                                                 complete_hvcc, sizeof complete_hvcc, true));
    assert(!loomtv_vlc_needs_inband_hevc_sets_4k(3840, 2160, 0, 0,
                                                 empty_hvcc, 22, true));
    assert(!loomtv_vlc_needs_inband_hevc_sets_4k(3840, 2160, 0, 0,
                                                 empty_hvcc, sizeof empty_hvcc, false));
    return 0;
}
