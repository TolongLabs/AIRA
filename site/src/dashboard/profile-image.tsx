import { FileInput } from '@/components/ui'
import { useEffect, useState, type ReactNode } from 'react'
import { MessageCircle, Users } from 'lucide-react'
import { core, type CoreChat } from '@/lib/core'
import { toast } from '@/lib/hooks'

type Kind = 'chats' | 'characters'
export const motifs = ['tidekeeper', 'orbit-guide', 'signal-finch'] as const
export function motif(id: string, index = 0) {
  return '/app/dashboard/' + (motifs.find((name) => name === id) ?? motifs[index % motifs.length]) + '.svg'
}

export function ProfileImage({
  kind,
  id,
  configured,
  fallback,
  className
}: {
  kind: Kind
  id: string
  configured?: boolean
  fallback: ReactNode
  className?: string
}) {
  const [src, setSrc] = useState('')
  const [uploaded, setUploaded] = useState(0)
  useEffect(() => {
    function refresh(event: Event) {
      if ((event as CustomEvent).detail === kind + '/' + id) setUploaded((n) => n + 1)
    }
    addEventListener('aira:portrait', refresh)
    return () => removeEventListener('aira:portrait', refresh)
  }, [kind, id])
  useEffect(() => {
    let live = true
    setSrc('')
    if (configured || uploaded)
      core
        .profileImage(kind, id)
        .then(({ image }) => {
          if (live && image) setSrc('data:image/webp;base64,' + image)
        })
        .catch(() => {})
    return () => {
      live = false
    }
  }, [kind, id, configured, uploaded])
  return src ? <img alt="" className={className} src={src} /> : <>{fallback}</>
}

export function ChatGlyph({ chat }: { chat: CoreChat }) {
  return (
    <span className="directory-avatar" aria-hidden="true">
      <ProfileImage
        kind="chats"
        id={chat.chatId}
        configured={chat.hasPortrait}
        fallback={chat.type === 'group' ? <Users size={20} /> : <MessageCircle size={20} />}
      />
    </span>
  )
}

export function PortraitUpload({ kind, id, onSaved }: { kind: Kind; id: string; onSaved?: () => void }) {
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  async function upload(file: File) {
    if (file.size > 4 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast('Choose a PNG, JPEG or WebP image under 4 MiB.', false)
      return
    }
    setBusy(true)
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1]!)
        reader.onerror = () => reject(new Error('Could not read image'))
        reader.readAsDataURL(file)
      })
      await core.saveImage(kind, id, encoded, file.type)
      dispatchEvent(new CustomEvent('aira:portrait', { detail: kind + '/' + id }))
      setVersion((n) => n + 1)
      onSaved?.()
      toast('Profile image saved.')
    } catch {
      toast('Image could not be saved. Choose a static image up to 4096 pixels per side and try again.', false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="portrait-upload">
      <ProfileImage
        key={version}
        kind={kind}
        id={id}
        configured
        className="portrait-sample"
        fallback={
          kind === 'characters' ? (
            <img alt="" className="portrait-sample" src={motif(id)} />
          ) : (
            <MessageCircle aria-hidden="true" />
          )
        }
      />
      <label>
        <strong>{kind === 'characters' ? 'Persona' : 'Chat'} profile image</strong>
        <small>PNG, JPEG or WebP · up to 4 MiB</small>
        <FileInput
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void upload(file)
          }}
        />
      </label>
    </div>
  )
}
