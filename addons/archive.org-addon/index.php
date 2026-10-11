<?php
// Archive.org public-domain Stremio addon (org.archive.clean).
//
// Drop-in for LiteSpeed / cPanel shared hosting. Upload this file together
// with manifest.json and .htaccess into:
//   <docroot>/stremio/archive.org-addon/
//
// Design: a fixed allowlist maps IMDb ids to Archive.org identifiers whose
// licenseurl was verified to contain a public-domain mark. Stream requests
// re-verify the item license live against archive.org metadata (1h file
// cache) and only then return a direct https download URL. Any id that is
// not on the allowlist, or whose license no longer verifies, gets an empty
// stream list - never a fuzzy-search guess. That is what makes the
// "public domain movies only" claim hold.
//
// Endpoints (relative to the addon base):
//   manifest.json
//   catalog/movie/archive-pd.json[?search=&skip=]
//   catalog/movie/archive-pd/search=...&skip=N.json (Stremio path-extra form)
//   meta/movie/ttXXXXXXX.json
//   stream/movie/ttXXXXXXX.json

declare(strict_types=1);

// PHP 7.4 compatibility: LiteSpeed hosts usually run PHP 8+, but these
// helpers keep the addon working on older runtimes too.
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool
    {
        return $needle === '' || strpos($haystack, $needle) === 0;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool
    {
        if ($needle === '') {
            return true;
        }
        return substr($haystack, -strlen($needle)) === $needle;
    }
}
if (!function_exists('str_contains')) {
    function str_contains(string $haystack, string $needle): bool
    {
        return $needle === '' || strpos($haystack, $needle) !== false;
    }
}

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(200);
    exit;
}

const ADDON_ID = 'org.archive.clean';
const CACHE_TTL = 3600;

function allowlist(): array
{
    // id => [imdb, title, year, genres, archive identifier, file, blurb]
    // Stream file names were verified against archive.org metadata; the
    // handler prefers the listed file but falls back to the best playable
    // file from the same item when the listing has changed.
    return [
        'tt0063350' => ['Night of the Living Dead', 1968, ['Horror'], 'night_of_the_living_dead_dvd', 'Night.mp4', 'Survivors barricade themselves in a farmhouse during a night of the living dead.'],
        'tt0051744' => ['House on Haunted Hill', 1959, ['Horror'], 'house_on_haunted_hill_1959-fhd', 'house_on_haunted_hill_1959.mp4', 'A millionaire offers guests a fortune to survive a night in a haunted house.'],
        'tt0052077' => ['Plan 9 from Outer Space', 1959, ['Sci-Fi'], 'plan-9-from-outer-space', 'plan-9-from-outer-space.mp4', 'Aliens resurrect the dead as part of a plan to stop humanity.'],
        'tt0054758' => ['Carnival of Souls', 1962, ['Horror'], 'carnival-of-souls-pnm', 'Carnival.of.Souls.1962.1080p.BluRay.X264-AMIABLE.mp4', 'A church organist survives a car crash and is drawn to an abandoned pavilion.'],
        'tt0040859' => ['D.O.A.', 1949, ['Film-Noir', 'Mystery'], 'd.-o.-a.-1950', 'D.O.A. (1949).mp4', 'A poisoned man races to find his own killer before time runs out.'],
        'tt0036775' => ['Detour', 1945, ['Film-Noir'], 'detour-1945', 'Detour 1945.mp4', 'A hitchhiker takes the wheel after a driver dies and slides into trouble.'],
        'tt0032599' => ['His Girl Friday', 1940, ['Comedy'], 'HisGirlFriday1940_201808', 'HisGirlFriday1940.mp4', 'A fast-talking editor tries to keep his star reporter from quitting.'],
        'tt0017925' => ['The General', 1926, ['Comedy'], 'the-general-1926-by-buster-keaton', 'The.General.1926.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4', 'A train engineer chases his stolen locomotive during the Civil War.'],
        'tt0013442' => ['Nosferatu', 1922, ['Horror'], 'nosferatu-1922_202504', 'Nosferatu (1922).mp4', 'Count Orlok brings plague and dread to a small German town.'],
        'tt0045897' => ['The Hitch-Hiker', 1953, ['Film-Noir'], 'Hitch_Hiker', 'Hitch-Hiker.mp4', 'Two friends pick up a hitchhiker who turns out to be a killer.'],
        'tt0047542' => ['Suddenly', 1954, ['Film-Noir'], 'suddenly', 'suddenly.mp4', 'A hired assassin waits on a rooftop above a train station.'],
        'tt0053340' => ['Teenagers from Outer Space', 1959, ['Sci-Fi'], 'TeenagersFromOuterSpace', 'TeenagersFromOuterSpace.mp4', 'Young aliens scout Earth for a place to graze their giant lobster-like livestock.'],
        'tt0028346' => ['Reefer Madness', 1936, ['Drama'], 'reefer-madness-1936-by-louis-j.-gasnier', 'Reefer.Madness.1936.1080p.WEBRip.x264-[YTS.AM].mp4', 'A cautionary tale about youth led astray, now a cult curiosity.'],
        'tt0054033' => ['The Little Shop of Horrors', 1960, ['Comedy', 'Horror'], 'the-little-shop-of-horrors-1960_202310', 'The Little Shop of Horrors (1960).mp4', 'A florist grows a plant with an appetite for people.'],
        'tt0055765' => ["The Brain That Wouldn't Die", 1962, ['Horror', 'Sci-Fi'], 'thebrainthatwouldntdie1962_202009', 'THEATRICAL CUT.mp4', 'A surgeon keeps his fiancee alive as a disembodied head.'],
        'tt0023694' => ['White Zombie', 1932, ['Horror'], 'white-zombie_hd', 'White Zombie.mp4', 'A young woman is turned into a zombie on a Haitian plantation.'],
        'tt0057579' => ['The Terror', 1963, ['Horror'], 'TheTerror', 'TheTerror.mp4', 'A French officer pursues a mysterious woman along a haunted coastline.'],
        'tt0053434' => ['The Wasp Woman', 1959, ['Horror', 'Sci-Fi'], 'the-wasp-woman-1959_202312', 'The Wasp Woman (1959).ia.mp4', 'A cosmetics queen tests a youth serum with monstrous side effects.'],
    ];
}

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function cache_path(string $key): string
{
    $dir = sys_get_temp_dir() . '/archive-addon-cache';
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    return $dir . '/' . preg_replace('/[^a-z0-9_.-]/i', '_', $key) . '.json';
}

function cache_get(string $key)
{
    $path = cache_path($key);
    if (!is_file($path) || (time() - filemtime($path)) > CACHE_TTL) {
        return null;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

function cache_set(string $key, array $value): void
{
    @file_put_contents(cache_path($key), json_encode($value), LOCK_EX);
}

function archive_metadata(string $identifier): ?array
{
    $cached = cache_get('meta-' . $identifier);
    if ($cached !== null) {
        return $cached;
    }
    $ctx = stream_context_create(['http' => ['timeout' => 6, 'header' => "Accept: application/json\r\nUser-Agent: loomtv-archive-addon/1.0\r\n"]]);
    $raw = @file_get_contents('https://archive.org/metadata/' . rawurlencode($identifier), false, $ctx);
    if ($raw === false) {
        return null;
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return null;
    }
    cache_set('meta-' . $identifier, $data);
    return $data;
}

function license_is_public_domain(array $metadata): bool
{
    $candidates = [];
    if (isset($metadata['metadata']['licenseurl'])) {
        $candidates[] = $metadata['metadata']['licenseurl'];
    }
    if (isset($metadata['licenseurl'])) {
        $candidates[] = $metadata['licenseurl'];
    }
    foreach ($candidates as $candidate) {
        foreach ((array) $candidate as $value) {
            if (is_string($value) && stripos($value, 'publicdomain') !== false) {
                return true;
            }
        }
    }
    return false;
}

function playable_files(array $metadata): array
{
    $files = [];
    foreach ($metadata['files'] ?? [] as $file) {
        if (!is_array($file) || !isset($file['name']) || !is_string($file['name'])) {
            continue;
        }
        $name = $file['name'];
        $lower = strtolower($name);
        if (!preg_match('/\.(mp4|m4v|webm|ogv|ogg)$/', $lower)) {
            continue;
        }
        if (preg_match('/(^|[_. -])(sample|trailer|preview|thumb)([_. -]|$)/i', $name)) {
            continue;
        }
        if ((string) ($file['size'] ?? '') === '0') || ($file['private'] ?? null) === true || ($file['private'] ?? null) === 'true') {
            continue;
        }
        $score = 0;
        if (str_ends_with($lower, '.mp4')) {
            $score = (str_contains($lower, '512kb') || str_contains($lower, 'lowres')) ? 70 : 100;
        } elseif (str_ends_with($lower, '.m4v')) {
            $score = 95;
        } elseif (str_ends_with($lower, '.webm')) {
            $score = 90;
        } else {
            $score = 80;
        }
        $files[] = ['name' => $name, 'size' => (int) ($file['size'] ?? 0), 'score' => $score];
    }
    usort($files, static fn($a, $b) => ($b['score'] <=> $a['score']) ?: ($b['size'] <=> $a['size']));
    return $files;
}

function download_url(string $identifier, string $filename): string
{
    $parts = array_map('rawurlencode', explode('/', $filename));
    return 'https://archive.org/download/' . rawurlencode($identifier) . '/' . implode('/', $parts);
}

function poster_url(string $identifier): string
{
    return 'https://archive.org/services/img/' . rawurlencode($identifier);
}

function meta_for(string $imdb, array $entry): array
{
    [$title, $year, $genres, $identifier] = $entry;
    return [
        'id' => $imdb,
        'type' => 'movie',
        'name' => $title,
        'poster' => poster_url($identifier),
        'background' => poster_url($identifier),
        'description' => $entry[5],
        'releaseInfo' => (string) $year,
        'year' => (string) $year,
        'genres' => $genres,
    ];
}

function handle_stream(string $imdb): void
{
    if (!preg_match('/^tt\d+$/', $imdb)) {
        json_out(['streams' => []]);
    }
    $list = allowlist();
    if (!isset($list[$imdb])) {
        // Not on the verified public-domain list: no streams, never a guess.
        json_out(['streams' => []]);
    }
    [$title, $year, $genres, $identifier, $preferredFile] = $list[$imdb];
    $metadata = archive_metadata($identifier);
    if ($metadata === null || !license_is_public_domain($metadata)) {
        json_out(['streams' => []]);
    }
    $videos = playable_files($metadata);
    if ($videos === []) {
        json_out(['streams' => []]);
    }
    $chosen = $videos[0]['name'];
    foreach ($videos as $video) {
        if ($video['name'] === $preferredFile) {
            $chosen = $video['name'];
            break;
        }
    }
    json_out(['streams' => [['url' => download_url($identifier, $chosen), 'title' => $title . ' (' . $year . ')']]]);
}

function handle_meta(string $imdb): void
{
    if (!preg_match('/^tt\d+$/', $imdb)) {
        json_out(['error' => 'Not found'], 404);
    }
    $list = allowlist();
    if (!isset($list[$imdb])) {
        json_out(['error' => 'Not found'], 404);
    }
    json_out(['meta' => meta_for($imdb, $list[$imdb])]);
}

function handle_catalog(array $query): void
{
    $search = strtolower(trim((string) ($query['search'] ?? '')));
    $skip = (int) ($query['skip'] ?? 0);
    if ($skip < 0) {
        $skip = 0;
    }
    $metas = [];
    foreach (allowlist() as $imdb => $entry) {
        $meta = meta_for($imdb, $entry);
        if ($search !== '' && stripos($meta['name'] . ' ' . $meta['releaseInfo'], $search) === false) {
            continue;
        }
        $metas[] = $meta;
    }
    json_out(['metas' => array_slice($metas, $skip, 100)]);
}

function handle_manifest(): void
{
    $local = __DIR__ . '/manifest.json';
    if (is_file($local)) {
        header('Content-Type: application/json; charset=utf-8');
        readfile($local);
        exit;
    }
    json_out([
        'id' => ADDON_ID,
        'version' => '10.1.0',
        'name' => 'Archive.org',
        'description' => 'Archive.org public domain movies only.',
        'logo' => 'https://archive.org/images/logo.jpg',
        'resources' => ['stream'],
        'types' => ['movie'],
        'idPrefixes' => ['tt'],
        'catalogs' => [],
    ]);
}

// ---- routing ----
$uri = (string) (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');
$path = urldecode($uri);
// Allow the addon to live under any base path; route on the tail.
if (preg_match('#/manifest\.json$#', $path)) {
    handle_manifest();
}
if (preg_match('#/catalog/([^/]+)/([^/.]+)(?:/(.+))?$#', $path, $m)) {
    $query = $_GET;
    if ($m[1] !== 'movie' || $m[2] !== 'archive-pd') {
        json_out(['error' => 'Not found'], 404);
    }
    // Stremio path-extra forms:
    //   /catalog/movie/archive-pd/search=foo.json
    //   /catalog/movie/archive-pd/skip=20.json
    //   /catalog/movie/archive-pd/search=foo&skip=20.json
    if (isset($m[3]) && $m[3] !== '') {
        $extraStr = (string) preg_replace('/\.json$/', '', $m[3]);
        parse_str(str_replace(';', '&', $extraStr), $extras);
        foreach ($extras as $k => $v) {
            if (!isset($query[$k]) && in_array($k, ['search', 'skip', 'genre'], true)) {
                $query[$k] = $v;
            }
        }
    }
    handle_catalog($query);
}
if (preg_match('#/meta/([^/]+)/([^/]+)$#', $path, $m)) {
    if ($m[1] !== 'movie') {
        json_out(['error' => 'Not found'], 404);
    }
    handle_meta((string) preg_replace('/\.json$/', '', $m[2]));
}
if (preg_match('#/stream/([^/]+)/([^/]+)$#', $path, $m)) {
    if ($m[1] !== 'movie') {
        json_out(['streams' => []]);
    }
    handle_stream((string) preg_replace('/\.json$/', '', $m[2]));
}

json_out(['error' => 'Not found'], 404);
