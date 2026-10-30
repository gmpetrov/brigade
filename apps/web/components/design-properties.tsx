'use client'
// The properties of what is selected on a design's canvas: its text, size,
// layout, spacing and look, read from the page (its computed values, and its
// inline ones first) and changed as inline styles and attributes. Each change
// goes out as it is made; the view shows it on the boards and saves it.
import type { DesignEditOp } from '@brigade/contracts'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowRight,
  Code2,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Inspected } from '@/components/design-canvas'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type Style = Record<string, string | null>

/** A value as the person sees it: what the page's style attribute says, else what the browser computed. */
const valueOf = (element: Inspected, property: string) =>
  element.inline[property] || element.computed[property] || ''

/** A length typed as a bare number is in px. */
const length = (value: string) =>
  /^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}px` : value.trim()

const hexes = new Map<string, string>()

/**
 * Any CSS colour (`oklch(…)`, `rgb(…)`, a name…) as `#rrggbb`, for the colour
 * picker, which takes nothing else and shows no transparency: the browser
 * paints it on a pixel and reads it back in sRGB.
 */
export function hex(color: string) {
  const value = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  const known = hexes.get(value)
  if (known) return known
  if (typeof document === 'undefined' || !value) return '#000000'
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!context) return '#000000'
  context.fillStyle = '#000'
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  const result = `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`
  hexes.set(value, result)
  return result
}

/** A short display for a computed value: `24px`, `1.5`, `0.8`. */
const tidy = (value: string) => value.replace(/(\.\d{2})\d+/g, '$1')

function Field({
  label,
  value,
  onCommit,
  disabled,
  lengthy = true,
  className,
  title,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
  disabled?: boolean
  /** A length: a bare number is px, arrows step it. */
  lengthy?: boolean
  className?: string
  title?: string
}) {
  const [draft, setDraft] = useState(tidy(value))
  useEffect(() => setDraft(tidy(value)), [value])
  const commit = (next = draft) => {
    const v = lengthy ? length(next) : next.trim()
    if (v !== tidy(value)) onCommit(v)
  }
  return (
    <Hint label={title ?? label}>
      <label className={cn('flex min-w-0 items-center gap-1.5', className)}>
        <span className="w-5 shrink-0 text-[11px] text-muted-foreground">{label}</span>
        <Input
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (lengthy && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i.exec(draft.trim())
              if (!m) return
              e.preventDefault()
              const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
              const next = `${Math.round((Number(m[1]) + step) * 100) / 100}${m[2] || 'px'}`
              setDraft(next)
              commit(next)
            }
          }}
          className="h-7 min-w-0 px-1.5 font-mono text-xs"
        />
      </label>
    </Hint>
  )
}

function ColorField({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string
  value: string
  onCommit: (value: string, live?: boolean) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        type="color"
        aria-label={label}
        disabled={disabled}
        value={hex(value)}
        onChange={(e) => onCommit(e.target.value, true)}
        className="h-7 w-8 shrink-0 cursor-pointer rounded border bg-transparent disabled:cursor-not-allowed"
      />
      <Input
        aria-label={`${label}, as CSS`}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
        onKeyDown={(e) => e.key === 'Enter' && draft.trim() !== value && onCommit(draft.trim())}
        className="h-7 min-w-0 px-1.5 font-mono text-xs"
      />
    </div>
  )
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border p-0.5">
      {options.map((o) => (
        <Hint key={o.value} label={o.title ?? o.value}>
          <button
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex h-6 min-w-0 flex-1 items-center justify-center rounded px-1.5 text-[11px] disabled:opacity-50',
              value === o.value
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        </Hint>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-3">
      <h3 className="text-xs font-semibold">{title}</h3>
      {children}
    </section>
  )
}

const WEIGHTS = ['300', '400', '500', '600', '700', '800']

export function DesignProperties({
  element,
  count,
  shared,
  teammate,
  onStyle,
  onAttrs,
  onText,
  onAsk,
}: {
  element: Inspected
  /** How many elements are selected: style changes go to all of them. */
  count: number
  /** The page shows on several boards (sizes): a change applies to each. */
  shared: boolean
  teammate?: string
  onStyle: (style: Style, coalesce?: string) => void
  onAttrs: (attrs: Extract<DesignEditOp, { attrs: unknown }>['attrs']) => void
  onText: (text: string) => void
  onAsk: () => void
}) {
  const [text, setText] = useState(element.text ?? '')
  useEffect(() => setText(element.text ?? ''), [element.h, element.text])
  const v = (property: string) => valueOf(element, property)
  const set = (property: string) => (value: string) => onStyle({ [property]: value || null })
  const styleOff = !element.editable.style
  const display = v('display')
  const flex = /flex/.test(display)
  const grid = /grid/.test(display)
  const isLink = element.tag === 'a' || 'href' in element.attrs
  const isImage = element.tag === 'img'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-1 border-b px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <Code2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="shrink-0 font-medium">{element.tag}</code>
          {element.label && (
            <span className="min-w-0 truncate text-muted-foreground">“{element.label}”</span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {count > 1 && `${count} selected, changes go to each · `}
          {element.dataId && (
            <>
              data-id <code>{element.dataId}</code> ·{' '}
            </>
          )}
          {element.line !== null && `line ${element.line}`}
          {shared && ' · shown at several sizes: a change applies to each'}
        </p>
        {element.scripted && (
          <p className="rounded-md bg-muted px-2 py-1.5 text-xs">
            {styleOff ? 'Made by the page’s script' : 'Its text comes from the page’s script'}: ask{' '}
            {teammate ?? 'the teammate'} to change it.{' '}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={onAsk}
            >
              Ask
            </button>
          </p>
        )}
      </div>

      {element.text !== null && (
        <Section title="Text">
          <Textarea
            aria-label="Text"
            value={text}
            rows={Math.min(5, Math.max(1, Math.ceil(text.length / 34)))}
            disabled={!element.editable.text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== (element.text ?? '') && onText(text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (text !== (element.text ?? '')) onText(text)
              }
            }}
            className="min-h-0 bg-card text-xs"
          />
          {element.editable.text && (
            <p className="text-[11px] text-muted-foreground">Or double-click it on the board.</p>
          )}
        </Section>
      )}

      <Section title="Typography">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Sz"
            title="Font size"
            value={v('font-size')}
            onCommit={set('font-size')}
            disabled={styleOff}
          />
          <Hint label="Font weight">
            <label className="flex min-w-0 items-center gap-1.5">
              <span className="w-5 shrink-0 text-[11px] text-muted-foreground">W</span>
              <select
                aria-label="Font weight"
                value={v('font-weight')}
                disabled={styleOff}
                onChange={(e) => set('font-weight')(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-1 text-xs"
              >
                {!WEIGHTS.includes(v('font-weight')) && (
                  <option value={v('font-weight')}>{v('font-weight')}</option>
                )}
                {WEIGHTS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          </Hint>
          <Field
            label="LH"
            title="Line height"
            value={v('line-height')}
            onCommit={set('line-height')}
            disabled={styleOff}
            lengthy={false}
          />
          <Field
            label="LS"
            title="Letter spacing"
            value={v('letter-spacing')}
            onCommit={set('letter-spacing')}
            disabled={styleOff}
          />
        </div>
        <ColorField
          label="Text colour"
          value={v('color')}
          disabled={styleOff}
          onCommit={(value, live) => onStyle({ color: value }, live ? 'color' : undefined)}
        />
        <Choice
          label="Align"
          value={v('text-align').replace(/^(start)$/, 'left')}
          disabled={styleOff}
          onChange={set('text-align')}
          options={[
            { value: 'left', label: <AlignLeft className="size-3.5" />, title: 'Left' },
            { value: 'center', label: <AlignCenter className="size-3.5" />, title: 'Center' },
            { value: 'right', label: <AlignRight className="size-3.5" />, title: 'Right' },
            { value: 'justify', label: <AlignJustify className="size-3.5" />, title: 'Justify' },
          ]}
        />
      </Section>

      <Section title="Size">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="W"
            title="Width (px, %, auto)"
            value={element.inline.width || v('width')}
            onCommit={set('width')}
            disabled={styleOff}
          />
          <Field
            label="H"
            title="Height (px, %, auto)"
            value={element.inline.height || v('height')}
            onCommit={set('height')}
            disabled={styleOff}
          />
        </div>
      </Section>

      {(flex || grid) && (
        <Section title={flex ? 'Flex layout' : 'Grid layout'}>
          {flex && (
            <div className="grid grid-cols-2 gap-2">
              <Choice
                label="Direction"
                value={v('flex-direction').startsWith('column') ? 'column' : 'row'}
                disabled={styleOff}
                onChange={set('flex-direction')}
                options={[
                  { value: 'row', label: <ArrowRight className="size-3.5" />, title: 'Row' },
                  { value: 'column', label: <ArrowDown className="size-3.5" />, title: 'Column' },
                ]}
              />
              <Choice
                label="Wrap"
                value={v('flex-wrap') === 'wrap' ? 'wrap' : 'nowrap'}
                disabled={styleOff}
                onChange={set('flex-wrap')}
                options={[
                  { value: 'nowrap', label: 'No wrap' },
                  { value: 'wrap', label: 'Wrap' },
                ]}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="Gap"
              title="Gap"
              value={
                v('row-gap') === v('column-gap')
                  ? v('row-gap')
                  : `${v('row-gap')} ${v('column-gap')}`
              }
              onCommit={set('gap')}
              disabled={styleOff}
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="w-14 shrink-0">Justify</span>
            <select
              value={v('justify-content')}
              disabled={styleOff}
              onChange={(e) => set('justify-content')(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-1 text-xs text-foreground"
            >
              {[
                'normal',
                'flex-start',
                'center',
                'flex-end',
                'space-between',
                'space-around',
                'space-evenly',
                'start',
                'end',
                'stretch',
              ].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="w-14 shrink-0">Align</span>
            <select
              value={v('align-items')}
              disabled={styleOff}
              onChange={(e) => set('align-items')(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-1 text-xs text-foreground"
            >
              {[
                'normal',
                'stretch',
                'flex-start',
                'center',
                'flex-end',
                'baseline',
                'start',
                'end',
              ].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}

      <Section title="Spacing">
        <p className="text-[11px] text-muted-foreground">Padding</p>
        <div className="grid grid-cols-4 gap-1.5">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <Field
              key={side}
              label={side[0]!.toUpperCase()}
              title={`Padding ${side}`}
              value={v(`padding-${side}`)}
              onCommit={set(`padding-${side}`)}
              disabled={styleOff}
            />
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">Margin</p>
        <div className="grid grid-cols-4 gap-1.5">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <Field
              key={side}
              label={side[0]!.toUpperCase()}
              title={`Margin ${side}`}
              value={v(`margin-${side}`)}
              onCommit={set(`margin-${side}`)}
              disabled={styleOff}
            />
          ))}
        </div>
      </Section>

      <Section title="Appearance">
        <ColorField
          label="Fill"
          value={v('background-color')}
          disabled={styleOff}
          onCommit={(value, live) =>
            onStyle({ 'background-color': value }, live ? 'fill' : undefined)
          }
        />
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Op"
            title="Opacity (0–1)"
            value={v('opacity')}
            onCommit={set('opacity')}
            disabled={styleOff}
            lengthy={false}
          />
          <Field
            label="R"
            title="Corner radius"
            value={v('border-top-left-radius')}
            onCommit={set('border-radius')}
            disabled={styleOff}
          />
          <Field
            label="B"
            title="Border width"
            value={v('border-top-width')}
            onCommit={(w) =>
              onStyle({
                'border-width': w || null,
                ...(v('border-top-style') === 'none' && w && w !== '0px'
                  ? { 'border-style': 'solid' }
                  : {}),
              })
            }
            disabled={styleOff}
          />
          <select
            aria-label="Border style"
            value={v('border-top-style')}
            disabled={styleOff}
            onChange={(e) => set('border-style')(e.target.value)}
            className="h-7 min-w-0 rounded-md border bg-transparent px-1 text-xs"
          >
            {['none', 'solid', 'dashed', 'dotted'].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <ColorField
          label="Border colour"
          value={v('border-top-color')}
          disabled={styleOff}
          onCommit={(value, live) =>
            onStyle({ 'border-color': value }, live ? 'border' : undefined)
          }
        />
      </Section>

      {(isLink || isImage) && (
        <Section title={isImage ? 'Image' : 'Link'}>
          {isLink && (
            <Field
              label="→"
              title="Address: a page of this design (signin.html), #section, or https://…"
              value={element.attrs.href ?? ''}
              onCommit={(href) => onAttrs({ href: href || null })}
              disabled={!element.editable.attrs}
              lengthy={false}
            />
          )}
          {isImage && (
            <>
              <Field
                label="Src"
                title="Image address: a file of this design, or https://…"
                value={element.attrs.src ?? ''}
                onCommit={(src) => onAttrs({ src: src || null })}
                disabled={!element.editable.attrs}
                lengthy={false}
              />
              <Field
                label="Alt"
                title="What the image shows, for people who cannot see it"
                value={element.attrs.alt ?? ''}
                onCommit={(alt) => onAttrs({ alt })}
                disabled={!element.editable.attrs}
                lengthy={false}
              />
            </>
          )}
        </Section>
      )}
    </div>
  )
}
