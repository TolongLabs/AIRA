// Shared-layout indicator adapted from ObsidianUI Dashboard Shell (MIT).
// See site/THIRD_PARTY_NOTICES.md.
import { motion, useReducedMotion } from 'motion/react'
import { useId } from 'react'
import type { ComponentType, SVGProps } from 'react'

const PILL_SPRING = { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 } as const

interface Entry {
  key: string
  label: string
  href: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
}

export function SidebarLinks({ active, entries }: { active: string | undefined; entries: Entry[] }) {
  const pillId = useId()
  const reduceMotion = useReducedMotion()
  return (
    <nav aria-label="Main navigation">
      {entries.map(({ key, label, href, Icon }) => (
        <a key={key} aria-label={label} aria-current={key === active ? 'page' : undefined} href={href}>
          {key === active && (
            <motion.span
              layoutId={pillId}
              aria-hidden="true"
              className="dashboard-active-pill"
              transition={reduceMotion ? { duration: 0 } : PILL_SPRING}
            />
          )}
          <Icon aria-hidden="true" />
          <span className="dashboard-nav-label">{label}</span>
        </a>
      ))}
    </nav>
  )
}
