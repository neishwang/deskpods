import {
  type ClientRect,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ipc } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import type { Folder, FolderId, Pod, PodId } from '@types'
import { Folder as FolderIcon, Plus } from 'lucide-react'
import { createContext, useContext, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  folderKey,
  rootEntriesFrom,
  selectFolderPods,
  selectFolders,
  selectRootPods,
  usePodStore
} from './usePodStore'

const ROOT = 'root'
type Container = typeof ROOT | FolderId

/**
 * Every icon (root Pod, folder icon, folder Pod) is a point on one vertical
 * axis. The icon whose row is nearest the pointer wins — deterministic and
 * gap-proof (no tall container ever "swallows" the drop). `resolve()` then uses
 * the pointer's position *inside that icon* to pick top / centre / bottom.
 *
 * The dragged item is excluded; when dragging a folder, only root-level icons
 * are considered (folders can't be reordered into another folder's list).
 */
const nearestIcon: CollisionDetection = ({
  active,
  droppableContainers,
  droppableRects,
  pointerCoordinates
}) => {
  if (!pointerCoordinates) return []
  const py = pointerCoordinates.y
  const draggingFolder = active.data.current?.type === 'folder'
  let best: UniqueIdentifier | null = null
  let bestDist = Number.POSITIVE_INFINITY

  for (const c of droppableContainers) {
    if (c.id === active.id || c.disabled) continue
    const d = c.data.current as { type?: string; container?: string } | undefined
    const isIcon =
      d?.type === 'folder' || (d?.type === 'pod' && (!draggingFolder || d.container === ROOT))
    if (!isIcon) continue
    const r = droppableRects.get(c.id)
    if (!r) continue
    // Vertical distance to the icon's row (0 when the pointer is level with it).
    const dy = py < r.top ? r.top - py : py > r.top + r.height ? py - (r.top + r.height) : 0
    if (dy < bestDist) {
      bestDist = dy
      best = c.id
    }
  }

  return best !== null ? [{ id: best }] : []
}

type Edge = 'top' | 'bottom'

/** Where the current drag would land, for the visual indicator. */
interface DropState {
  anchorId?: string
  edge?: Edge
  mergeId?: string
  folderHi?: string
  /** True while any drag is in progress (lets folders un-clip their drop lines). */
  dragActive?: boolean
}
const DropContext = createContext<DropState>({})

/** Compact fallback badge from a name (first letter). */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

/** Hex colour with an appended alpha byte, falling back to the surface token. */
function tint(color: string | undefined, alpha: string): string {
  return color ? `${color}${alpha}` : 'var(--color-surface)'
}

/** Show the overlay tooltip anchored to the right-centre of the hovered icon. */
function showTip(e: React.PointerEvent<HTMLElement>, text: string): void {
  const r = e.currentTarget.getBoundingClientRect()
  void ipc.showTooltip({ text, x: r.right, y: r.top + r.height / 2 })
}
const hideTip = (): void => {
  void ipc.hideTooltip()
}

// Returns a ReactNode rather than an element: with no favicon the icon IS a
// bare letter, drawn by the parent's own centring — wrapping it in anything
// would change how it sits.
function PodIcon({ pod }: { pod: Pod }): React.ReactNode {
  return pod.icon ? <img src={pod.icon} alt="" className="h-6 w-6 rounded" /> : initial(pod.name)
}

/** Red dot: the Pod (or a Pod inside the folder) has unread notifications. */
function UnreadDot(): React.JSX.Element {
  return (
    <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-surface)] bg-red-500" />
  )
}

/** Spinning ring shown around an icon while its Pod's page is loading. */
function LoadingRing(): React.JSX.Element {
  return (
    <span className="pointer-events-none absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-[var(--color-accent)]" />
  )
}

/** Thin accent bar shown above/below an icon to mark the drop position. */
function DropLine({ edge }: { edge: Edge }): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-[var(--color-accent)]"
      style={edge === 'top' ? { top: -5 } : { bottom: -5 }}
    />
  )
}

// --- Pods -----------------------------------------------------------------

function PodButton({
  pod,
  container,
  disabled = false
}: {
  pod: Pod
  container: Container
  disabled?: boolean
}): React.JSX.Element {
  const activePodId = usePodStore((s) => s.activePodId)
  const setActive = usePodStore((s) => s.setActive)
  const drop = useContext(DropContext)
  // Pods in a collapsed folder stay mounted (for the open/close animation) but
  // must not take part in drag detection, or they'd shadow the folder icon.
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: pod.id,
    data: { type: 'pod', container },
    disabled
  })

  const merging = drop.mergeId === pod.id
  const lineEdge = drop.anchorId === pod.id ? drop.edge : undefined

  return (
    <div className="relative">
      {lineEdge && <DropLine edge={lineEdge} />}
      {/* "Will create / join a folder" halo enveloping the target icon. Sized
          well beyond the icon so it stays visible around the dragged overlay
          (which is dimmed while merging). */}
      {merging && (
        <div
          className="pointer-events-none absolute -inset-2 rounded-[26px] ring-2 ring-[var(--color-accent)]"
          style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)' }}
        />
      )}
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        onPointerEnter={(e) => showTip(e, pod.name)}
        onPointerLeave={hideTip}
        onClick={() => void setActive(pod.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          void ipc.showPodMenu(pod.id)
        }}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-sm font-semibold transition duration-150',
          isDragging && 'opacity-0',
          merging && 'scale-110',
          pod.id === activePodId
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:text-white'
        )}
      >
        <PodIcon pod={pod} />
      </button>
      {pod.loading && <LoadingRing />}
      {pod.unread && !isDragging && <UnreadDot />}
    </div>
  )
}

// --- Folders (Discord-style) ---------------------------------------------

function MiniIcon({ pod }: { pod?: Pod }): React.JSX.Element {
  if (!pod) return <div className="h-full w-full rounded-[4px] bg-[var(--color-bg)]/50" />
  return pod.icon ? (
    <img src={pod.icon} alt="" className="h-full w-full rounded-[4px] object-cover" />
  ) : (
    <div className="flex h-full w-full items-center justify-center rounded-[4px] bg-[var(--color-bg)] text-[8px] font-semibold text-white">
      {initial(pod.name)}
    </div>
  )
}

function FolderBlock({ folder }: { folder: Folder }): React.JSX.Element {
  const pods = usePodStore(useShallow(selectFolderPods(folder.id)))
  const toggleFolder = usePodStore((s) => s.toggleFolder)
  const drop = useContext(DropContext)
  const expanded = !folder.collapsed
  const key = folderKey(folder.id)

  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: key,
    data: { type: 'folder', folderId: folder.id }
  })

  const highlighted = drop.folderHi === folder.id
  const lineEdge = drop.anchorId === key ? drop.edge : undefined
  // Collapsed folders show the 2×2 preview grid (empty folders auto-delete, so
  // the grid is never empty). Expanded folders show the plain folder icon.
  const showGrid = !expanded
  // When expanded, a drop-target highlight tints the whole block, not just the icon.
  const blockBg = expanded
    ? highlighted
      ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)'
      : tint(folder.color, '1f')
    : 'transparent'

  return (
    <div
      className="relative flex w-[52px] flex-col items-center rounded-2xl transition-colors duration-200"
      style={{ backgroundColor: blockBg }}
    >
      {lineEdge && <DropLine edge={lineEdge} />}
      <div className="relative py-1">
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          style={{
            backgroundColor: tint(folder.color, expanded ? '40' : '26'),
            color: folder.color ?? '#f8fafc'
          }}
          onPointerEnter={(e) => showTip(e, folder.name)}
          onPointerLeave={hideTip}
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            void ipc.showFolderMenu(folder.id)
          }}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-colors',
            isDragging && 'opacity-0',
            // Expanded folders convey the highlight via the block background;
            // collapsed ones (just the icon) use a ring instead.
            highlighted && !expanded && 'ring-2 ring-[var(--color-accent)]'
          )}
        >
          {showGrid ? (
            <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-0.5 p-1">
              <MiniIcon pod={pods[0]} />
              <MiniIcon pod={pods[1]} />
              <MiniIcon pod={pods[2]} />
              <MiniIcon pod={pods[3]} />
            </div>
          ) : folder.icon ? (
            <span className="text-lg leading-none">{folder.icon}</span>
          ) : (
            <FolderIcon className="h-5 w-5" fill="currentColor" />
          )}
        </button>
        {/* Expanded folders show the dots on the Pods themselves. */}
        {!expanded && pods.some((p) => p.unread) && <UnreadDot />}
      </div>

      {/* 0fr -> 1fr animates height without knowing the content size. */}
      <div
        className="grid w-full transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div
          className={cn(
            'flex w-full flex-col items-center gap-2',
            // Un-clip only while dragging an expanded folder, so the drop line at
            // the first/last pod is visible; otherwise clip for the collapse anim.
            drop.dragActive && expanded ? 'overflow-visible' : 'overflow-hidden'
          )}
        >
          <SortableContext items={pods.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {pods.map((pod) => (
              <PodButton key={pod.id} pod={pod} container={folder.id} disabled={!expanded} />
            ))}
          </SortableContext>
          <div className="h-1 shrink-0" aria-hidden />
        </div>
      </div>
    </div>
  )
}

/** Layout wrapper for the root list. `flex-1` lets it fill the whole sidebar so
 *  the empty area below the last icon is still a drop target (drop-at-end). */
function RootContainer({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex w-full flex-1 flex-col items-center gap-2">{children}</div>
}

// --- Drag & drop resolution ----------------------------------------------

/** Current pointer Y = where the drag started + how far it has moved. dnd-kit
 *  doesn't hand us live pointer coords in drag events, so we reconstruct them. */
function pointerYOf(event: DragEndEvent | DragOverEvent): number | null {
  const start = event.activatorEvent as { clientY?: number }
  return typeof start?.clientY === 'number' ? start.clientY + event.delta.y : null
}

/** Vertical position of the POINTER within the `over` rect (0 = top, 1 = bottom).
 *  Pointer-based (not item-centre) so the drop edge follows the cursor exactly. */
function ratioOf(pointerY: number | null, over: ClientRect | undefined): number {
  if (pointerY === null || !over || !over.height) return 0.5
  return (pointerY - over.top) / over.height
}
const isMerge = (ratio: number): boolean => ratio > 0.3 && ratio < 0.7

type Resolution =
  | { kind: 'merge'; overId: PodId; activeId: PodId }
  | { kind: 'into-folder'; folderId: FolderId; activeId: PodId }
  | { kind: 'folder-line'; folderId: FolderId; anchorPodId: PodId; edge: Edge; activeId: PodId }
  | {
      kind: 'root-line'
      anchorKey: string
      edge: Edge
      activeKind: 'pod' | 'folder'
      activeId: string
    }
  | null

function resolve(event: DragEndEvent | DragOverEvent): Resolution {
  const { active, over } = event
  if (!over) return null
  const aData = active.data.current
  const oData = over.data.current
  const ratio = ratioOf(pointerYOf(event), over.rect)
  const store = usePodStore.getState()

  // Dragging a folder: only reorders among root entries.
  if (aData?.type === 'folder') {
    const activeId = aData.folderId as FolderId
    if (oData?.type === 'folder' || (oData?.type === 'pod' && oData.container === ROOT)) {
      if (over.id === folderKey(activeId)) return null
      return {
        kind: 'root-line',
        anchorKey: over.id as string,
        edge: ratio < 0.5 ? 'top' : 'bottom',
        activeKind: 'folder',
        activeId
      }
    }
    return null
  }

  if (aData?.type !== 'pod') return null
  const activeId = active.id as PodId

  if (oData?.type === 'pod') {
    if (over.id === activeId) return null
    const overPod = store.pods.find((p) => p.id === over.id)
    if (!overPod) return null
    if (isMerge(ratio)) {
      return overPod.folderId === null
        ? { kind: 'merge', overId: overPod.id, activeId }
        : { kind: 'into-folder', folderId: overPod.folderId, activeId }
    }
    const edge: Edge = ratio < 0.5 ? 'top' : 'bottom'
    return overPod.folderId === null
      ? { kind: 'root-line', anchorKey: overPod.id, edge, activeKind: 'pod', activeId }
      : { kind: 'folder-line', folderId: overPod.folderId, anchorPodId: overPod.id, edge, activeId }
  }

  if (oData?.type === 'folder') {
    const folderId = oData.folderId as FolderId
    // Centre of the folder icon → drop inside it; top/bottom edge → place the
    // pod at root before/after the folder (so you can drop *between* folders).
    if (isMerge(ratio)) return { kind: 'into-folder', folderId, activeId }
    return {
      kind: 'root-line',
      anchorKey: folderKey(folderId),
      edge: ratio < 0.5 ? 'top' : 'bottom',
      activeKind: 'pod',
      activeId
    }
  }

  return null
}

function toDropState(res: Resolution): DropState {
  if (!res) return {}
  switch (res.kind) {
    case 'merge':
      return { mergeId: res.overId }
    case 'into-folder':
      return { folderHi: res.folderId }
    case 'folder-line':
      // Highlight the whole folder too, so it's always clear the pod lands inside.
      return { anchorId: res.anchorPodId, edge: res.edge, folderHi: res.folderId }
    case 'root-line':
      return { anchorId: res.anchorKey, edge: res.edge }
  }
}

/** Order the ids inside a folder, active removed, then inserted at `index`. */
function folderOrder(pods: Pod[], folderId: FolderId, activeId: PodId, index: number): PodId[] {
  const list = pods
    .filter((p) => p.folderId === folderId && p.id !== activeId)
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id)
  list.splice(Math.max(0, Math.min(index, list.length)), 0, activeId)
  return list
}

function applyResolution(res: Resolution): void {
  if (!res) return
  const store = usePodStore.getState()

  switch (res.kind) {
    case 'merge':
      void store.createFolderWithPods([res.overId, res.activeId])
      return
    case 'into-folder': {
      const list = folderOrder(store.pods, res.folderId, res.activeId, Number.POSITIVE_INFINITY)
      store.reorderPods(list.map((id, order) => ({ id, folderId: res.folderId, order })))
      return
    }
    case 'folder-line': {
      const base = store.pods
        .filter((p) => p.folderId === res.folderId && p.id !== res.activeId)
        .sort((a, b) => a.order - b.order)
        .map((p) => p.id)
      let idx = base.indexOf(res.anchorPodId)
      if (res.edge === 'bottom') idx += 1
      const list = folderOrder(store.pods, res.folderId, res.activeId, idx < 0 ? base.length : idx)
      store.reorderPods(list.map((id, order) => ({ id, folderId: res.folderId, order })))
      return
    }
    case 'root-line': {
      const entries = rootEntriesFrom(store.pods, store.folders).filter(
        (e) => !(e.kind === res.activeKind && e.id === res.activeId)
      )
      let idx = entries.findIndex((e) => e.key === res.anchorKey)
      if (idx < 0) idx = entries.length
      else if (res.edge === 'bottom') idx += 1
      entries.splice(idx, 0, {
        kind: res.activeKind,
        id: res.activeId,
        key: res.activeKind === 'folder' ? folderKey(res.activeId) : res.activeId,
        order: 0
      })
      store.reorderRoot(entries.map((e) => ({ kind: e.kind, id: e.id })))
      return
    }
  }
}

// --- Sidebar --------------------------------------------------------------

interface Dragging {
  type: 'pod' | 'folder'
  id: string
}

export function Sidebar(): React.JSX.Element {
  const rootPods = usePodStore(useShallow(selectRootPods))
  const folders = usePodStore(useShallow(selectFolders))
  const [dragging, setDragging] = useState<Dragging | null>(null)
  const [drop, setDrop] = useState<DropState>({})
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const rootEntries = useMemo(() => rootEntriesFrom(rootPods, folders), [rootPods, folders])

  const onDragStart = (event: DragStartEvent) => {
    hideTip()
    const data = event.active.data.current
    if (data?.type === 'pod') setDragging({ type: 'pod', id: event.active.id as string })
    else if (data?.type === 'folder') setDragging({ type: 'folder', id: data.folderId as string })
  }

  const onDragOver = (event: DragOverEvent) => {
    const next = toDropState(resolve(event))
    setDrop((prev) =>
      prev.anchorId === next.anchorId &&
      prev.edge === next.edge &&
      prev.mergeId === next.mergeId &&
      prev.folderHi === next.folderHi
        ? prev
        : next
    )
  }

  const endDrag = () => {
    setDragging(null)
    setDrop({})
  }

  const onDragEnd = (event: DragEndEvent) => {
    applyResolution(resolve(event))
    endDrag()
  }

  const draggingPod =
    dragging?.type === 'pod' ? usePodStore.getState().pods.find((p) => p.id === dragging.id) : null
  const draggingFolder =
    dragging?.type === 'folder'
      ? usePodStore.getState().folders.find((f) => f.id === dragging.id)
      : null

  return (
    <nav className="flex h-full w-16 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)] py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <DndContext
        sensors={sensors}
        collisionDetection={nearestIcon}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <DropContext.Provider value={dragging ? { ...drop, dragActive: true } : drop}>
          <RootContainer>
            <SortableContext
              items={rootEntries.map((e) => e.key)}
              strategy={verticalListSortingStrategy}
            >
              {rootEntries.map((entry) =>
                entry.kind === 'pod' ? (
                  <PodButton
                    key={entry.key}
                    pod={rootPods.find((p) => p.id === entry.id) as Pod}
                    container={ROOT}
                  />
                ) : (
                  <FolderBlock
                    key={entry.key}
                    folder={folders.find((f) => f.id === entry.id) as Folder}
                  />
                )
              )}
            </SortableContext>

            {/* Inside the root droppable so the empty space below it stays a
                valid drop target (drop-at-end). */}
            <button
              type="button"
              onPointerEnter={(e) => showTip(e, 'Add Pod')}
              onPointerLeave={hideTip}
              onClick={() => usePodStore.getState().setDialog({ type: 'add-pod' })}
              className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] text-[var(--color-muted)] hover:text-white"
            >
              <Plus className="h-5 w-5" />
            </button>
          </RootContainer>
        </DropContext.Provider>

        <DragOverlay dropAnimation={null}>
          {draggingPod ? (
            // Fade the dragged icon while it would merge, so the target's halo
            // underneath stays visible.
            <div
              className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-accent)] text-sm font-semibold text-white shadow-lg transition-opacity"
              style={{ opacity: drop.mergeId ? 0.35 : 1 }}
            >
              <PodIcon pod={draggingPod} />
            </div>
          ) : draggingFolder ? (
            <div
              className="flex h-11 w-11 items-center justify-center rounded-2xl shadow-lg"
              style={{
                backgroundColor: tint(draggingFolder.color, '40'),
                color: draggingFolder.color ?? '#f8fafc'
              }}
            >
              <FolderIcon className="h-5 w-5" fill="currentColor" />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </nav>
  )
}
