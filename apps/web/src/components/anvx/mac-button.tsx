import { ButtonHTMLAttributes } from 'react'

export default function MacButton({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
}) {
  const base =
    'text-[11px] font-bold uppercase tracking-wider font-ui px-3 py-1.5 rounded-sm transition-colors disabled:opacity-50'

  const styles =
    variant === 'primary'
      ? 'bg-anvx-acc text-white hover:opacity-90'
      : 'bg-anvx-win border border-anvx-bdr text-anvx-text hover:bg-anvx-bg'

  return <button className={`${base} ${styles} ${className}`} {...props} />
}
