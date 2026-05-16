export default function LoomPlayMark({
  className = '',
  color = 'currentColor',
}: {
  className?: string;
  color?: string;
}) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M4 4.43171C4 2.52232 6.11644 1.36004 7.74316 2.37604L7.8252 2.4278V15.3712H13.9102L15.9424 16.501L7.74316 21.6231C6.1164 22.6395 4 21.4779 4 19.5684V4.43171ZM19.8574 9.94538C21.3808 10.8972 21.3808 13.103 19.8574 14.0548L18.377 14.9805L14.583 12.8712H10.375V4.02058L19.8574 9.94538Z"
        fill={color}
      />
    </svg>
  );
}
