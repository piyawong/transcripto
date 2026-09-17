import Image from "next/image";
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

/** App icon beside the "Transcripto" wordmark; decorative because the link text already names the app.
    Same artwork as app/icon.png and app/favicon.ico. */
export function BrandMark() {
  return <Image className="brand-mark" src="/transcripto-icon.png" alt="" width={32} height={32} unoptimized loading="eager" />;
}
