import { ICONS } from "@/lib/icons";

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg
      className={`i ${className}`.trim()}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] ?? "" }}
    />
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <rect x="6.5" y="12.5" width="3" height="7" rx="1.5" fill="#46D1C0" />
        <rect x="12" y="7" width="3" height="18" rx="1.5" fill="#A6A9FF" />
        <rect x="17.5" y="10" width="3" height="12" rx="1.5" fill="#FF9C82" />
        <rect x="23" y="13.5" width="3" height="5" rx="1.5" fill="#F2C45C" />
      </svg>
    </span>
  );
}
