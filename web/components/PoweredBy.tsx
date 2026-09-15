import Image from "next/image";

/** Credit to Pichvara. Opens in a new tab so an upload or the video playing here keeps going. */
export function PoweredBy() {
  return (
    <a className="powered" href="https://pichvara.com" target="_blank" rel="noopener" data-testid="powered-by">
      <span>Powered by</span>
      <Image src="/pichvara-logo.png" alt="Pichvara" width={81} height={24} unoptimized />
      <span className="sr-only">(เปิดในแท็บใหม่)</span>
    </a>
  );
}
