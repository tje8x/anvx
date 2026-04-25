import { ButtonHTMLAttributes } from 'react'

export default function MacButton({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
}) {
  const base =
    'text-[11px] font-bold uppercase tracking-wider font-ui px-3 py-1.5 rounded-sm transition-all duration-150 ease-out disabled:opacity-50'

  const styles =
    variant === 'primary'
      ? 'bg-anvx-acc text-white hover:brightness-110 active:brightness-95'
      : 'bg-anvx-win border border-anvx-bdr text-anvx-text hover:bg-anvx-bg active:bg-anvx-bdr/30'

  return <button className={`${base} ${styles} ${className}`} {...props} />
}
