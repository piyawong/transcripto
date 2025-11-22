import { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function AnimatedGradientText({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "group relative mx-auto flex max-w-fit flex-row items-center justify-center rounded-full bg-white/40 px-4 py-1.5 text-sm font-medium shadow-md backdrop-blur-lg transition-shadow hover:shadow-xl dark:bg-black/40",
        className,
      )}
    >
      <span className="inline-flex animate-gradient bg-gradient-to-r from-[#e11d48] via-[#be123c] to-[#e11d48] bg-[length:200%_auto] bg-clip-text text-transparent">
        {children}
      </span>
    </div>
  )
}