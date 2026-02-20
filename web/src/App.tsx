import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Box, Button, Container, TextField, Typography, Paper, Chip, Stack, MenuItem, Divider } from '@mui/material'

const templates = ['base', 'ai_compute', 'on_orbit_servicing']
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://127.0.0.1:5071'
  : `http://${window.location.hostname}:5071`

const SNAP_STEP = 0.25

type Phase = { name: string; duration: number }

type Window = { name: string; start: number; end: number }

type WindowMask = { name: string; start: number; end: number; mode: 'allow' | 'deny'; source_type: string; source_ref?: string }

type Activity = { id: string; name: string; start: number; duration: number; row: number }
type RequirementRule = { activity_type: string; rule: string; threshold?: string }

type Interval = { start: number; end: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const snapToStep = (value: number) => Math.round(value / SNAP_STEP) * SNAP_STEP

const normalizeIntervals = (intervals: Interval[]) => {
  const sorted = intervals
    .map(i => ({ start: Math.min(i.start, i.end), end: Math.max(i.start, i.end) }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  sorted.forEach(i => {
    const last = merged[merged.length - 1]
    if (!last || i.start > last.end) {
      merged.push({ ...i })
    } else {
      last.end = Math.max(last.end, i.end)
    }
  })
  return merged
}

const subtractIntervals = (base: Interval[], subtract: Interval[]) => {
  let remaining = [...base]
  subtract.forEach(block => {
    const next: Interval[] = []
    remaining.forEach(seg => {
      if (block.end <= seg.start || block.start >= seg.end) {
        next.push(seg)
      } else {
        if (block.start > seg.start) next.push({ start: seg.start, end: block.start })
        if (block.end < seg.end) next.push({ start: block.end, end: seg.end })
      }
    })
    remaining = next
  })
  return remaining
}

const buildAllowedIntervals = (totalDuration: number, windows: Window[], masks: WindowMask[]) => {
  const legacyAllows = windows.map(w => ({ start: w.start, end: w.end }))
  const allowMasks = masks.filter(m => m.mode === 'allow').map(m => ({ start: m.start, end: m.end }))
  const denyMasks = masks.filter(m => m.mode === 'deny').map(m => ({ start: m.start, end: m.end }))
  const base = allowMasks.length > 0
    ? normalizeIntervals(allowMasks)
    : (legacyAllows.length > 0 ? normalizeIntervals(legacyAllows) : [{ start: 0, end: totalDuration }])
  const trimmed = base.map(i => ({ start: clamp(i.start, 0, totalDuration), end: clamp(i.end, 0, totalDuration) }))
  const allowed = subtractIntervals(normalizeIntervals(trimmed), normalizeIntervals(denyMasks))
  return allowed
}

const intervalContains = (allowed: Interval[], start: number, end: number) => {
  return allowed.some(i => start >= i.start && end <= i.end)
}

const nearestAllowedStart = (desired: number, duration: number, allowed: Interval[]) => {
  let bestStart: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const i of allowed) {
    const latest = i.end - duration
    if (latest < i.start) continue
    const candidate = clamp(desired, i.start, latest)
    const distance = Math.abs(candidate - desired)
    if (distance < bestDistance) {
      bestDistance = distance
      bestStart = candidate
    }
  }
  return bestStart
}

const explainPlacement = (activity: Activity, allowed: Interval[], deny: Interval[], masks: WindowMask[], rules: RequirementRule[]) => {
  const start = activity.start
  const end = activity.start + activity.duration
  const messages: string[] = []
  if (start < 0 || end < 0) messages.push('Activity starts before timeline begins')
  if (end <= start) messages.push('Activity duration must be positive')
  if (!intervalContains(allowed, start, end)) {
    messages.push('Activity is not fully inside allowed windows')
  }
  const overlapDeny = deny.filter(d => !(end <= d.start || start >= d.end))
  if (overlapDeny.length > 0) {
    messages.push('Activity overlaps deny windows')
  }

  const contactOverlap = masks
    .filter(m => m.mode === 'allow' && m.source_type === 'ground_contact')
    .some(m => !(end <= m.start || start >= m.end))
  const commBlackoutOverlap = masks
    .filter(m => m.mode === 'deny' && m.source_type === 'comms_blackout')
    .some(m => !(end <= m.start || start >= m.end))

  const activityType = activity.name.toLowerCase()
  rules.forEach(r => {
    if (r.activity_type.toLowerCase() !== activityType) return
    if (r.rule === 'requires_contact' && !contactOverlap) {
      messages.push('Rule failed: requires contact window overlap')
    }
    if (r.rule === 'requires_contact_or_blackout_leq') {
      const ok = contactOverlap || !commBlackoutOverlap
      if (!ok) messages.push(`Rule failed: requires contact OR comm_blackout <= ${r.threshold || 'X'}`)
    }
    if (r.rule === 'forbid_during_eclipse') {
      const eclipseOverlap = masks
        .filter(m => m.mode === 'deny' && m.source_type === 'eclipse')
        .some(m => !(end <= m.start || start >= m.end))
      if (eclipseOverlap) messages.push('Rule failed: forbidden during eclipse')
    }
  })

  return { ok: messages.length === 0, messages }
}

export default function App() {
  const [intent, setIntent] = useState('earth_observation')
  const [stakeholders, setStakeholders] = useState('operations, science, ground segment')
  const [template, setTemplate] = useState('base')
  const [autonomy, setAutonomy] = useState(2)
  const [comms, setComms] = useState('store-and-forward')
  const [maxMass, setMaxMass] = useState(200)
  const [maxPower, setMaxPower] = useState(500)
  const [downlink, setDownlink] = useState(5)

  const [phases, setPhases] = useState<Phase[]>([
    { name: 'Launch', duration: 1 },
    { name: 'Commissioning', duration: 2 },
    { name: 'Ops', duration: 6 },
    { name: 'EOL', duration: 1 }
  ])
  const [newPhase, setNewPhase] = useState('')
  const [newDuration, setNewDuration] = useState(1)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [exportResult, setExportResult] = useState<any>(null)

  const [windows, setWindows] = useState<Window[]>([])
  const [newWindow, setNewWindow] = useState<Window>({ name: '', start: 0, end: 1 })

  const [windowMasks, setWindowMasks] = useState<WindowMask[]>([])
  const [newMask, setNewMask] = useState<WindowMask>({ name: '', start: 0, end: 1, mode: 'allow', source_type: 'ground_contact', source_ref: '' })

  const [requirementRules, setRequirementRules] = useState<RequirementRule[]>([])
  const [newRule, setNewRule] = useState<RequirementRule>({ activity_type: 'capture', rule: 'requires_contact_or_blackout_leq', threshold: '120s' })

  const [rows, setRows] = useState<string[]>(['Row A', 'Row B', 'Row C'])
  const [newRow, setNewRow] = useState('')

  const [activities, setActivities] = useState<Activity[]>([])
  const [newActivity, setNewActivity] = useState({ name: '', duration: 1, row: 0 })
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [projects, setProjects] = useState<any[]>([])
  const [status, setStatus] = useState<string>('')

  const timelineRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const dragState = useRef<{ id: string; originX: number; originStart: number; width: number; total: number } | null>(null)

  const phasesWithOffsets = useMemo(() => {
    let cursor = 0
    return phases.map(p => {
      const start = cursor
      const end = cursor + p.duration
      cursor = end
      return { ...p, start, end }
    })
  }, [phases])

  const totalDuration = useMemo(() => phasesWithOffsets.reduce((sum, p) => sum + p.duration, 0), [phasesWithOffsets])

  const allowedIntervals = useMemo(() => buildAllowedIntervals(totalDuration, windows, windowMasks), [totalDuration, windows, windowMasks])
  const denyIntervals = useMemo(() => windowMasks.filter(m => m.mode === 'deny').map(m => ({ start: m.start, end: m.end })), [windowMasks])

  const addPhase = () => {
    if (!newPhase.trim()) return
    setPhases([...phases, { name: newPhase.trim(), duration: newDuration }])
    setNewPhase('')
  }

  const movePhase = (from: number, to: number) => {
    const next = [...phases]
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    setPhases(next)
  }

  const setPhaseDuration = (idx: number, duration: number) => {
    const next = [...phases]
    next[idx] = { ...next[idx], duration }
    setPhases(next)
  }

  const fetchProjects = async () => {
    const res = await fetch(`${API_BASE}/projects`)
    setProjects(await res.json())
  }

  const saveProject = async () => {
    if (!projectName.trim()) return
    const payload = buildPayload()
    const res = await fetch(`${API_BASE}/projects?name=` + encodeURIComponent(projectName), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    await res.json()
    fetchProjects()
  }

  const loadProject = async (id: number) => {
    const res = await fetch(`${API_BASE}/projects/` + id)
    const data = await res.json()
    if (!data.data) return
    const d = data.data
    setIntent(d.intent)
    setStakeholders(d.stakeholders)
    setTemplate(d.template)
    setAutonomy(d.autonomy_level)
    setComms(d.comms_policy)
    setMaxMass(d.max_mass_kg)
    setMaxPower(d.max_power_w)
    setDownlink(d.downlink_gb_per_day)
    setPhases(d.phases.map((p: any) => ({ name: p.name, duration: p.duration || 1 })))
    setWindows(d.windows || [])
    setWindowMasks((d.window_masks || []).map((m: any) => ({
      name: m.name,
      start: m.start,
      end: m.end,
      mode: m.mode || 'allow',
      source_type: m.source_type || 'ground_contact',
      source_ref: m.source_ref || ''
    })))
    setRequirementRules(d.requirement_rules || [])
    setRows(d.timeline_rows && d.timeline_rows.length > 0 ? d.timeline_rows : ['Row A', 'Row B', 'Row C'])
    setActivities((d.activities || []).map((a: any, idx: number) => ({ id: a.id || `${idx}-${a.name}`, name: a.name, start: a.start, duration: a.duration || 1, row: a.row || 0 })))
  }

  const buildPayload = () => ({
    intent,
    stakeholders,
    template,
    autonomy_level: autonomy,
    comms_policy: comms,
    max_mass_kg: maxMass,
    max_power_w: maxPower,
    downlink_gb_per_day: downlink,
    phases: phases.map((p, i) => ({ name: p.name, order: i, duration: p.duration })),
    windows,
    window_masks: windowMasks,
    activities: activities.map(a => ({ name: a.name, start: a.start, duration: a.duration, row: a.row })),
    requirement_rules: requirementRules,
    timeline_rows: rows
  })

  const exportSpec = async () => {
    try {
      setStatus('Exporting...')
      const payload = buildPayload()
      const res = await fetch(`${API_BASE}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (!res.ok) {
        setStatus(`Export failed: ${res.status}`)
        setExportResult(data)
        return
      }
      setExportResult(data)
      setStatus('Export complete')
    } catch (e: any) {
      setStatus(`Export error: ${e?.message || e}`)
    }
  }

  const addRow = () => {
    if (!newRow.trim()) return
    setRows([...rows, newRow.trim()])
    setNewRow('')
  }

  const addActivity = () => {
    if (!newActivity.name.trim()) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const start = snapToStep(0)
    setActivities([...activities, { id, name: newActivity.name.trim(), start, duration: newActivity.duration || 1, row: newActivity.row }])
    setNewActivity({ name: '', duration: 1, row: newActivity.row })
  }

  const updateActivity = (id: string, patch: Partial<Activity>) => {
    setActivities(prev => prev.map(a => (a.id === id ? { ...a, ...patch } : a)))
  }

  const applySnap = (activity: Activity) => {
    const desired = snapToStep(activity.start)
    const candidate = nearestAllowedStart(desired, activity.duration, allowedIntervals)
    const start = candidate ?? desired
    return { ...activity, start: clamp(start, 0, Math.max(0, totalDuration - activity.duration)) }
  }

  const onDragStart = (activity: Activity, rowIndex: number) => (e: ReactMouseEvent) => {
    const key = `${rowIndex}`
    const node = timelineRefs.current.get(key)
    if (!node) return
    const rect = node.getBoundingClientRect()
    dragState.current = { id: activity.id, originX: e.clientX, originStart: activity.start, width: rect.width, total: totalDuration }
    setSelectedActivityId(activity.id)
  }

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragState.current) return
      const { id, originX, originStart, width, total } = dragState.current
      const delta = e.clientX - originX
      const deltaTime = (delta / width) * total
      const target = activities.find(a => a.id === id)
      if (!target) return
      const start = clamp(originStart + deltaTime, 0, Math.max(0, total - target.duration))
      updateActivity(id, { start: snapToStep(start) })
    }

    const handleUp = () => {
      if (!dragState.current) return
      const target = activities.find(a => a.id === dragState.current?.id)
      if (target) {
        const snapped = applySnap(target)
        updateActivity(target.id, { start: snapped.start })
      }
      dragState.current = null
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [activities, allowedIntervals, totalDuration])

  const selectedActivity = activities.find(a => a.id === selectedActivityId) || null
  const selectedExplain = selectedActivity ? explainPlacement(selectedActivity, allowedIntervals, denyIntervals, windowMasks, requirementRules) : null

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h4" gutterBottom>ConOps Builder v2</Typography>
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Intent + Stakeholders</Typography>
        <TextField fullWidth label="Mission intent" sx={{ mt: 1 }} value={intent} onChange={e => setIntent(e.target.value)} />
        <TextField fullWidth label="Stakeholders" sx={{ mt: 2 }} value={stakeholders} onChange={e => setStakeholders(e.target.value)} />
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Phases Timeline</Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mt: 1 }}>
          {phases.map((p, i) => (
            <Chip key={i} label={`${p.name} (${p.duration})`} draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIndex === null) return; movePhase(dragIndex, i); setDragIndex(null) }}
              onClick={() => i > 0 && movePhase(i, i - 1)} onDelete={() => i < phases.length - 1 && movePhase(i, i + 1)} />
          ))}
        </Stack>
        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          <TextField label="New phase" value={newPhase} onChange={e => setNewPhase(e.target.value)} />
          <TextField type="number" label="Duration" value={newDuration} onChange={e => setNewDuration(parseFloat(e.target.value) || 1)} />
          <Button variant="contained" onClick={addPhase}>Add Phase</Button>
        </Box>
        <Typography variant="caption" color="text.secondary">Click chip to move left. Use delete icon to move right.</Typography>
        <Typography variant="subtitle2" sx={{ mt: 2 }}>Timeline Canvas</Typography>
        <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'stretch', border: '1px solid #ddd', p: 1 }}>
          {phases.map((p, i) => (
            <Box key={i} sx={{ flex: p.duration, minWidth: 60, p: 1, bgcolor: '#e3f2fd', border: '1px solid #90caf9', textAlign: 'center' }}>
              <Typography variant="caption" display="block">{p.name}</Typography>
              <TextField size="small" type="number" label="Dur" value={p.duration} onChange={e => setPhaseDuration(i, parseFloat(e.target.value) || 1)} />
            </Box>
          ))}
        </Box>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Objectives (Template)</Typography>
        <TextField select label="Template" value={template} onChange={e => setTemplate(e.target.value)} sx={{ mt: 1 }}>
          {templates.map(t => (<MenuItem key={t} value={t}>{t}</MenuItem>))}
        </TextField>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Legacy Windows (Compatibility)</Typography>
        <Typography variant="caption" color="text.secondary">Optional. Used only when no allow masks exist.</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={newWindow.name} onChange={e => setNewWindow({ ...newWindow, name: e.target.value })} />
          <TextField type="number" label="Start" value={newWindow.start} onChange={e => setNewWindow({ ...newWindow, start: parseFloat(e.target.value) })} />
          <TextField type="number" label="End" value={newWindow.end} onChange={e => setNewWindow({ ...newWindow, end: parseFloat(e.target.value) })} />
          <Button variant="outlined" onClick={() => {
            if (!newWindow.name) return
            setWindows([...windows, newWindow])
            setNewWindow({ name: '', start: 0, end: 1 })
          }}>Add Legacy Window</Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
          {windows.map((w, i) => (
            <Chip key={i} label={`${w.name} (${w.start}-${w.end})`} onDelete={() => setWindows(windows.filter((_, j) => j !== i))} />
          ))}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Window Masks (Primary)</Typography>
        <Typography variant="caption" color="text.secondary">Declarative allow/forbid masks with source types. TradeSpaceKit computes real windows per design point.</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }}>
          <TextField label="Name" value={newMask.name} onChange={e => setNewMask({ ...newMask, name: e.target.value })} />
          <TextField select label="Mode" value={newMask.mode} onChange={e => setNewMask({ ...newMask, mode: e.target.value as WindowMask['mode'] })}>
            <MenuItem value="allow">allow</MenuItem>
            <MenuItem value="deny">deny</MenuItem>
          </TextField>
          <TextField select label="Source Type" value={newMask.source_type} onChange={e => setNewMask({ ...newMask, source_type: e.target.value })}>
            <MenuItem value="ground_contact">ground_contact</MenuItem>
            <MenuItem value="imaging_window">imaging_window</MenuItem>
            <MenuItem value="approach_window">approach_window</MenuItem>
            <MenuItem value="thruster_allowed">thruster_allowed</MenuItem>
            <MenuItem value="comms_blackout">comms_blackout</MenuItem>
            <MenuItem value="eclipse">eclipse</MenuItem>
            <MenuItem value="star_tracker_blinding">star_tracker_blinding</MenuItem>
            <MenuItem value="keep_out_geometry">keep_out_geometry</MenuItem>
          </TextField>
          <TextField label="Source Ref" value={newMask.source_ref || ''} onChange={e => setNewMask({ ...newMask, source_ref: e.target.value })} />
          <TextField type="number" label="Start" value={newMask.start} onChange={e => setNewMask({ ...newMask, start: parseFloat(e.target.value) })} />
          <TextField type="number" label="End" value={newMask.end} onChange={e => setNewMask({ ...newMask, end: parseFloat(e.target.value) })} />
          <Button variant="outlined" onClick={() => {
            if (!newMask.name) return
            setWindowMasks([...windowMasks, newMask])
            setNewMask({ name: '', start: 0, end: 1, mode: 'allow', source_type: 'ground_contact', source_ref: '' })
          }}>Add Mask</Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
          {windowMasks.map((w, i) => (
            <Chip key={i} color={w.mode === 'deny' ? 'warning' : 'success'} label={`${w.name} (${w.mode} ${w.start}-${w.end}, ${w.source_type})`} onDelete={() => setWindowMasks(windowMasks.filter((_, j) => j !== i))} />
          ))}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Activity Gating Rules (Operational Contract)</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }}>
          <TextField label="Activity Type" value={newRule.activity_type} onChange={e => setNewRule({ ...newRule, activity_type: e.target.value })} />
          <TextField select label="Rule" value={newRule.rule} onChange={e => setNewRule({ ...newRule, rule: e.target.value })}>
            <MenuItem value="requires_contact">requires_contact</MenuItem>
            <MenuItem value="requires_contact_or_blackout_leq">requires_contact_or_blackout_leq</MenuItem>
            <MenuItem value="forbid_during_eclipse">forbid_during_eclipse</MenuItem>
          </TextField>
          <TextField label="Threshold" value={newRule.threshold || ''} onChange={e => setNewRule({ ...newRule, threshold: e.target.value })} />
          <Button variant="outlined" onClick={() => {
            if (!newRule.activity_type || !newRule.rule) return
            setRequirementRules([...requirementRules, newRule])
            setNewRule({ activity_type: 'capture', rule: 'requires_contact_or_blackout_leq', threshold: '120s' })
          }}>Add Rule</Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
          {requirementRules.map((r, i) => (
            <Chip key={i} label={`${r.activity_type}: ${r.rule}${r.threshold ? ` (${r.threshold})` : ''}`} onDelete={() => setRequirementRules(requirementRules.filter((_, j) => j !== i))} />
          ))}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Activity Timeline (Multi-row)</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          <TextField label="Row name" value={newRow} onChange={e => setNewRow(e.target.value)} />
          <Button variant="outlined" onClick={addRow}>Add Row</Button>
        </Stack>
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <TextField label="Activity" value={newActivity.name} onChange={e => setNewActivity({ ...newActivity, name: e.target.value })} />
          <TextField type="number" label="Duration" value={newActivity.duration} onChange={e => setNewActivity({ ...newActivity, duration: parseFloat(e.target.value) || 1 })} />
          <TextField select label="Row" value={newActivity.row} onChange={e => setNewActivity({ ...newActivity, row: parseInt(e.target.value) })}>
            {rows.map((r, idx) => (<MenuItem key={r} value={idx}>{r}</MenuItem>))}
          </TextField>
          <Button variant="contained" onClick={addActivity}>Add Activity</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">Drag activities horizontally; they snap to allowed windows and grid.</Typography>

        <Divider sx={{ my: 2 }} />

        <Box sx={{ border: '1px solid #ddd', borderRadius: 1 }}>
          <Box sx={{ display: 'flex', borderBottom: '1px solid #eee' }}>
            {phasesWithOffsets.map((p, i) => (
              <Box key={i} sx={{ flex: p.duration, p: 1, textAlign: 'center', bgcolor: '#fafafa', borderRight: '1px solid #eee' }}>
                <Typography variant="caption">{p.name}</Typography>
              </Box>
            ))}
          </Box>
          {rows.map((row, rowIndex) => {
            const rowKey = `${rowIndex}`
            const rowActivities = activities.filter(a => a.row === rowIndex)
            return (
              <Box key={row} sx={{ position: 'relative', borderBottom: '1px solid #eee', minHeight: 56 }}>
                <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 140, borderRight: '1px solid #eee', p: 1, bgcolor: '#fafafa' }}>
                  <Typography variant="caption">{row}</Typography>
                </Box>
                <Box
                  ref={(node) => {
                    if (node instanceof HTMLDivElement) timelineRefs.current.set(rowKey, node)
                  }}
                  sx={{ ml: '140px', position: 'relative', height: 56, bgcolor: '#fff' }}
                >
                  {allowedIntervals.map((interval, idx) => (
                    <Box
                      key={idx}
                      sx={{
                        position: 'absolute',
                        left: `${(interval.start / totalDuration) * 100}%`,
                        width: `${((interval.end - interval.start) / totalDuration) * 100}%`,
                        top: 0,
                        bottom: 0,
                        bgcolor: 'rgba(76, 175, 80, 0.08)'
                      }}
                    />
                  ))}
                  {rowActivities.map(activity => {
                    const left = totalDuration > 0 ? (activity.start / totalDuration) * 100 : 0
                    const width = totalDuration > 0 ? (activity.duration / totalDuration) * 100 : 0
                    const explain = explainPlacement(activity, allowedIntervals, denyIntervals, windowMasks, requirementRules)
                    return (
                      <Box
                        key={activity.id}
                        onMouseDown={onDragStart(activity, rowIndex)}
                        onClick={() => setSelectedActivityId(activity.id)}
                        sx={{
                          position: 'absolute',
                          left: `${left}%`,
                          width: `${width}%`,
                          top: 10,
                          height: 36,
                          bgcolor: explain.ok ? '#e3f2fd' : '#ffebee',
                          border: `1px solid ${explain.ok ? '#90caf9' : '#ef9a9a'}`,
                          borderRadius: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'grab',
                          userSelect: 'none'
                        }}
                      >
                        <Typography variant="caption">{activity.name}</Typography>
                      </Box>
                    )
                  })}
                </Box>
              </Box>
            )
          })}
        </Box>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle2">Activities</Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
          {activities.map(a => (
            <Chip key={a.id} label={`${a.name} (${a.start.toFixed(2)}-${(a.start + a.duration).toFixed(2)})`} onClick={() => setSelectedActivityId(a.id)} onDelete={() => setActivities(activities.filter(x => x.id !== a.id))} />
          ))}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Explain-Why Panel</Typography>
        {selectedActivity ? (
          <Box sx={{ mt: 1 }}>
            <Typography variant="subtitle2">{selectedActivity.name}</Typography>
            <Typography variant="body2">Start: {selectedActivity.start.toFixed(2)} | Duration: {selectedActivity.duration}</Typography>
            {selectedExplain && selectedExplain.ok ? (
              <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>Placement is valid.</Typography>
            ) : (
              <Box sx={{ mt: 1 }}>
                {(selectedExplain?.messages || []).map((msg, idx) => (
                  <Typography key={idx} variant="body2" color="warning.main">• {msg}</Typography>
                ))}
                <Button sx={{ mt: 1 }} size="small" variant="outlined" onClick={() => {
                  if (!selectedActivity) return
                  const snapped = applySnap(selectedActivity)
                  updateActivity(selectedActivity.id, { start: snapped.start })
                }}>Snap to nearest allowed</Button>
              </Box>
            )}
            <Divider sx={{ my: 2 }} />
            <Typography variant="caption" color="text.secondary">Allowed intervals: {allowedIntervals.map(i => `[${i.start}-${i.end}]`).join(', ') || 'none'}</Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">Select an activity to see placement details.</Typography>
        )}
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Project Storage</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          <TextField label="Project name" value={projectName} onChange={e => setProjectName(e.target.value)} />
          <Button variant="outlined" onClick={saveProject}>Save Project</Button>
          <Button variant="outlined" onClick={fetchProjects}>Refresh List</Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
          {projects.map(p => (
            <Button key={p.id} onClick={() => loadProject(p.id)} variant="text">Load: {p.name}</Button>
          ))}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Policies + Constraints</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          <TextField type="number" label="Autonomy level" value={autonomy} onChange={e => setAutonomy(parseInt(e.target.value))} />
          <TextField label="Comms policy" value={comms} onChange={e => setComms(e.target.value)} />
        </Stack>
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <TextField type="number" label="Max mass (kg)" value={maxMass} onChange={e => setMaxMass(parseFloat(e.target.value))} />
          <TextField type="number" label="Max power (W)" value={maxPower} onChange={e => setMaxPower(parseFloat(e.target.value))} />
          <TextField type="number" label="Downlink GB/day" value={downlink} onChange={e => setDownlink(parseFloat(e.target.value))} />
        </Stack>
      </Paper>

      <Button variant="contained" onClick={exportSpec}>Export mission.yaml + patch + summary</Button>
      {status && <Typography sx={{ mt: 1 }}>{status}</Typography>}

      {exportResult && (
        <Paper sx={{ p: 2, mt: 3 }}>
          <Typography variant="h6">Export Result</Typography>
          <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
            <Button href={`${API_BASE}/download/${exportResult.mission}`} target="_blank">Download mission.yaml</Button>
            <Button href={`${API_BASE}/download/${exportResult.patch}`} target="_blank">Download patch</Button>
            <Button href={`${API_BASE}/download/${exportResult.summary}`} target="_blank">Download summary</Button>
          </Stack>
          <pre>{JSON.stringify(exportResult, null, 2)}</pre>
        </Paper>
      )}
    </Container>
  )
}
