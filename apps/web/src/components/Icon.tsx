import type { SVGProps } from 'react';

export type IconName =
  | 'calendar'
  | 'users'
  | 'box'
  | 'chat'
  | 'plus'
  | 'left'
  | 'right'
  | 'close'
  | 'search'
  | 'logout'
  | 'clock'
  | 'alert'
  | 'check'
  | 'phone'
  | 'trash'
  | 'edit'
  | 'mic'
  | 'paw'
  | 'refresh'
  | 'back'
  | 'sparkle'
  | 'tag'
  | 'camera';

const PATHS: Record<IconName, string> = {
  calendar:
    'M8 3v3M16 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  users:
    'M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M16 4.1a3.5 3.5 0 0 1 0 6.8',
  box: 'M20 8.5 12 4 4 8.5v7L12 20l8-4.5v-7ZM4 8.5 12 13l8-4.5M12 13v7',
  chat: 'M20 12a7 7 0 0 1-7 7H8l-4 3v-4.4A7 7 0 0 1 4 12a8 8 0 0 1 8-8h1a7 7 0 0 1 7 7Z',
  plus: 'M12 5v14M5 12h14',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  close: 'm6 6 12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  logout: 'M15 17v2a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2M10 12h10m0 0-3-3m3 3-3 3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  alert: 'M12 9v4m0 4h.01M10.3 4.3 2.6 17.6A1.5 1.5 0 0 0 3.9 20h16.2a1.5 1.5 0 0 0 1.3-2.4L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z',
  check: 'm5 12.5 4.5 4.5L19 7',
  phone:
    'M6.5 3.5h2l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v2a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
  paw: 'M12 13c2.5 0 4 1.6 4 3.2 0 1.3-1 2.3-2.4 2.3-.8 0-1.1-.3-1.6-.3s-.8.3-1.6.3C9 18.5 8 17.5 8 16.2 8 14.6 9.5 13 12 13ZM7.5 11.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM16.5 11.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM4.8 15.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM19.2 15.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z',
  refresh: 'M20 11a8 8 0 0 0-14-4.5L4 9M4 5v4h4M4 13a8 8 0 0 0 14 4.5L20 15m0 4v-4h-4',
  back: 'M19 12H5m0 0 6-6m-6 6 6 6',
  sparkle: 'M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16l-1.8-4.5L5 9.7l5.2-1.8L12 3Z',
  tag: 'M20 12.5 12.5 20a2 2 0 0 1-2.8 0L4 14.3V4h10.3L20 9.7a2 2 0 0 1 0 2.8ZM8 8h.01',
  camera:
    'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
};

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
};

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
