import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive'
type ButtonSize = 'default' | 'sm' | 'icon'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

const variants: Record<ButtonVariant, string> = {
  default: 'bg-[#0052FF] text-white shadow-sm hover:bg-[#0047D0]',
  secondary: 'bg-[#F0F3FA] text-[#434651] hover:bg-[#E0E3EB]',
  ghost: 'text-[#787B86] hover:bg-[#F0F3FA] hover:text-[#1E222D]',
  outline: 'border border-[#E0E3EB] bg-white text-[#434651] hover:border-[#0052FF] hover:bg-[#F8F9FA]',
  destructive: 'bg-[#F23645] text-white shadow-sm hover:bg-[#D92B39]',
}

const sizes: Record<ButtonSize, string> = {
  default: 'min-h-11 px-4 py-2 text-sm',
  sm: 'min-h-10 px-3 py-1.5 text-xs',
  icon: 'h-11 w-11 p-2',
}

export function Button({ className, variant = 'default', size = 'default', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0052FF]/20',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}
