"use client"

import React, { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

interface AnimatedCircularProgressBarProps {
  max: number
  value: number
  radius?: number
  strokeWidth?: number
  className?: string
}

export function AnimatedCircularProgressBar({
  max,
  value,
  radius = 60,
  strokeWidth = 8,
  className,
}: AnimatedCircularProgressBarProps) {
  const normalizedRadius = radius - strokeWidth / 2
  const circumference = normalizedRadius * 2 * Math.PI
  const strokeDashoffset = circumference - (value / max) * circumference
  const [isAnimated, setIsAnimated] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setIsAnimated(true), 100)
    return () => clearTimeout(timer)
  }, [])

  return (
    <svg
      height={radius * 2}
      width={radius * 2}
      className={cn("transform -rotate-90", className)}
    >
      <circle
        stroke="currentColor"
        fill="transparent"
        opacity={0.2}
        strokeWidth={strokeWidth}
        r={normalizedRadius}
        cx={radius}
        cy={radius}
      />
      <circle
        stroke="currentColor"
        fill="transparent"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference + " " + circumference}
        style={{
          strokeDashoffset: isAnimated ? strokeDashoffset : circumference,
          transition: isAnimated ? "stroke-dashoffset 1s ease-in-out" : "",
        }}
        r={normalizedRadius}
        cx={radius}
        cy={radius}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        className="text-2xl font-bold fill-current transform rotate-90"
        style={{ transformOrigin: "center" }}
      >
        {Math.round((value / max) * 100)}%
      </text>
    </svg>
  )
}