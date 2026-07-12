import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';

export type IconProps = {
  size?: number;
  color?: string;
};

export function LoomLogo({
  accent = '#fbc500',
  height = 24,
  width = 86,
  wordColor = '#ffffff',
}: {
  accent?: string;
  height?: number;
  width?: number;
  wordColor?: string;
}) {
  return (
    <Svg width={width} height={height} viewBox="0 0 86 24" fill="none">
      <Path d="M27.3787 16.1202C27.0955 15.5557 26.9823 15.6686 26.9823 5H25V15.6686C25 17.3056 25.9628 18.8297 27.8884 18.8297H29.4742V16.9669H28.4548C27.8884 16.9669 27.5486 16.6847 27.3787 16.1202Z" fill={wordColor} />
      <Path d="M35.3639 8.8385C32.5888 8.8385 30.1534 10.9835 30.1534 13.9752C30.1534 16.5154 32.1357 18.9991 35.194 18.9991C38.3656 19.0555 40.2913 16.5718 40.2913 13.9752C40.3479 11.3222 38.1391 8.8385 35.3639 8.8385ZM35.3073 17.1928C33.3817 17.1928 32.0224 15.7816 32.0224 13.9188C32.0224 12.2818 33.3817 10.7577 35.194 10.7577C37.1197 10.7013 38.5355 12.1689 38.5355 13.9752C38.4789 15.6687 37.063 17.1928 35.3073 17.1928Z" fill={wordColor} />
      <Path d="M46.4636 8.83846C44.1981 8.83846 41.4796 10.6448 41.4796 13.9188C41.4796 16.9105 43.745 18.9426 46.4636 18.9426C49.1821 18.999 51.7873 16.9669 51.7873 13.9752C51.844 10.9835 49.352 8.78202 46.9733 8.83846H46.4636ZM46.5202 17.1927C44.7645 17.1927 43.292 15.838 43.292 13.9188C43.292 12.1689 44.8211 10.7577 46.3503 10.7577H46.5768C48.1626 10.7012 49.9184 11.9995 49.9184 13.9188C49.9184 15.7815 48.4458 17.1927 46.5202 17.1927Z" fill={wordColor} />
      <Path d="M60.5063 10.1878C61.3505 9.30152 62.1497 8.88639 63.1125 8.83841C65.2645 8.78196 66.9634 10.7576 66.9068 12.9591V18.7732H65.1512V12.9591C65.1512 11.7172 64.2451 10.7012 63.1125 10.7576C61.6401 10.7576 60.8473 11.8866 60.8473 13.0155V18.7732H58.9785V12.8462C58.9785 11.8301 58.129 10.7012 56.9964 10.7576C55.6939 10.7576 54.901 11.8866 54.901 13.0155V18.7732H53.0322V12.8462C53.0322 10.4754 55.1276 8.78196 57.3928 8.83841C58.9889 8.83841 59.8361 9.4782 60.5063 10.1878Z" fill={wordColor} />
      <Path d="M81.845 9.06992L79.0701 16.6339L76.2951 9.12637H71.6514V6.13464H69.6693V9.06992H67.8005V10.8763H69.6127V15.7872C69.6693 17.4242 70.6321 18.8354 72.6708 18.8354H74.5962V16.9726H73.2371C72.4443 16.9726 71.8779 16.6904 71.6514 15.7308V10.8198H75.1059L78.164 18.8354H79.9761L83.5439 9.97309L83.6005 9.83861L83.6571 9.71954L83.7304 9.57795L83.8494 9.34087L84 9.06992H83.7138H81.845Z" fill={wordColor} />
      <Path d="M2 4.43171C2 2.52232 4.11644 1.36004 5.74316 2.37604L5.8252 2.4278V15.3712H11.9102L13.9424 16.501L5.74316 21.6231C4.1164 22.6395 2 21.4779 2 19.5684V4.43171ZM17.8574 9.94538C19.3808 10.8972 19.3808 13.103 17.8574 14.0548L16.377 14.9805L12.583 12.8712H8.375V4.02058L17.8574 9.94538Z" fill={accent} />
    </Svg>
  );
}

// Loom Media Player brand play-mark, taken verbatim from the desktop LoomPlayMark SVG
// (apps/desktop/src/components/LoomPlayMark.tsx). Single source of brand truth.
export function PlayMark({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 4.43171C4 2.52232 6.11644 1.36004 7.74316 2.37604L7.8252 2.4278V15.3712H13.9102L15.9424 16.501L7.74316 21.6231C6.1164 22.6395 4 21.4779 4 19.5684V4.43171ZM19.8574 9.94538C21.3808 10.8972 21.3808 13.103 19.8574 14.0548L18.377 14.9805L14.583 12.8712H10.375V4.02058L19.8574 9.94538Z"
        fill={color}
      />
    </Svg>
  );
}

// Phosphor "House" — matches the desktop Sidebar HomeIcon.
export function HomeIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" fill={color}>
      <Path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z" />
    </Svg>
  );
}

// Matches the desktop Sidebar custom AnimeIcon verbatim, including the interior
// kimono-fold cutouts that render via the even-odd fill rule.
export function AnimeIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        fill={color}
        fillRule="evenodd"
        d="M21.778 3.372a1 1 0 0 1 .116 1.075l-2 4a1 1 0 0 1-.777.546q-1.557.178-3.117.306v1.366a58 58 0 0 0 3.797-.644a1 1 0 0 1 .406 1.958q-.6.122-1.203.23V18a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2v-5.095c-.692.059-1.374.095-2 .095s-1.308-.037-2-.095V18a1 1 0 1 1 0 2H5a1 1 0 0 1 0-2v-5.79a51 51 0 0 1-1.203-.23a1 1 0 0 1 .406-1.96c1.258.258 2.525.47 3.797.645V9.299a100 100 0 0 1-3.116-.306a1.01 1.01 0 0 1-.778-.546l-2-4a1 1 0 0 1 1.143-1.415l.47.117l.952.224l.856.191l.642.137l.337.069q.398.08.81.158l.83.15c1.392.24 2.798.422 3.854.422s2.462-.181 3.853-.421l.83-.15l.81-.16l.98-.205l.856-.19l.482-.113q.471-.11.939-.23a1 1 0 0 1 1.028.34ZM17 18v-5.459l-.66.096l-.34.046V18zM7 12.541v5.46h1v-5.318l-.675-.094zm7-1.644v-1.46l-.827.04c-.407.014-.803.023-1.173.023s-.766-.009-1.173-.024L10 9.438v1.459c.703.063 1.387.103 2 .103c.49 0 1.026-.025 1.581-.068zm4.349-3.83l.801-1.604l-1.175.256c-1.967.42-3.972.781-5.975.781s-4.008-.361-5.975-.78L4.85 5.462l.801 1.603c2.107.226 4.23.434 6.349.434c1.817 0 3.636-.153 5.445-.339l.904-.095Z"
      />
    </Svg>
  );
}

// lucide-react "Tv" — matches the desktop Sidebar.
export function TVIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={2} y={7} width={20} height={15} rx={2} ry={2} />
      <Polyline points="17 2 12 7 7 2" />
    </Svg>
  );
}

// lucide-react "Film" — matches the desktop Sidebar Movies icon.
export function MoviesIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={3} y={3} width={18} height={18} rx={2} />
      <Path d="M7 3v18" />
      <Path d="M3 7.5h4" />
      <Path d="M3 12h18" />
      <Path d="M3 16.5h4" />
      <Path d="M17 3v18" />
      <Path d="M17 7.5h4" />
      <Path d="M17 16.5h4" />
    </Svg>
  );
}

// lucide-react "Folder" — matches the desktop Sidebar Others icon.
export function FolderIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </Svg>
  );
}

// lucide-react "Settings" — matches the desktop mobile-nav "More"/Settings slot.
export function MoreIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <Circle cx={12} cy={12} r={3} />
    </Svg>
  );
}

export function SearchIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
        fill={color}
      />
    </Svg>
  );
}

export function FilterIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" />
    </Svg>
  );
}

export function RefreshIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
        fill={color}
      />
    </Svg>
  );
}

export function SunIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
      <Circle cx={12} cy={12} r={3.5} />
      <Path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
    </Svg>
  );
}

export function AutoThemeIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={8} stroke={color} strokeWidth={1.8} />
      <Path d="M12 4a8 8 0 0 0 0 16V4Z" fill={color} />
    </Svg>
  );
}

export function MoonIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20.7 15.2A8.5 8.5 0 0 1 8.8 3.3 8.5 8.5 0 1 0 20.7 15.2Z"
        fill={color}
      />
    </Svg>
  );
}

export function PlayIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M8 5v14l11-7L8 5z" fill={color} />
    </Svg>
  );
}

export function RoundedPlayIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8.8 5.5 17.3 11c.95.62.95 1.38 0 2l-8.5 5.5C7.6 19.27 6.5 18.7 6.5 17.6V6.4c0-1.1 1.1-1.67 2.3-.9Z"
        fill={color}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={1.25}
      />
    </Svg>
  );
}

export function CloseIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
        fill={color}
      />
    </Svg>
  );
}

export function BackIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59z" fill={color} />
    </Svg>
  );
}

export function ChevronRightIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" fill={color} />
    </Svg>
  );
}

export function PauseIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill={color} />
    </Svg>
  );
}

// Material "replay" arc; the skip amount is rendered as a Text overlay by the player.
export function SkipBackIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill={color} />
    </Svg>
  );
}

export function SkipForwardIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" fill={color} />
    </Svg>
  );
}

export function SubtitlesIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"
        fill={color}
      />
    </Svg>
  );
}

// Material "graphic_eq" — audio track selector.
export function AudioTracksIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z" fill={color} />
    </Svg>
  );
}

// Material "speed" — playback rate selector.
export function SpeedIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"
        fill={color}
      />
    </Svg>
  );
}

export function CheckIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill={color} />
    </Svg>
  );
}

export function StarIcon({ size = 24, color = '#ffffff' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z"
        fill={color}
      />
    </Svg>
  );
}

export const navIcons = {
  home: HomeIcon,
  anime: AnimeIcon,
  tv: TVIcon,
  movies: MoviesIcon,
  settings: MoreIcon,
} as const;
