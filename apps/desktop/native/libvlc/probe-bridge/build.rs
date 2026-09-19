fn main() {
    cc::Build::new().file("src/log_callback.c").compile("loomtv_vlc_log_callback");
}
