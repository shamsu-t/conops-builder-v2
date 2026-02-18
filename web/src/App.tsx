import { useState } from 'react'
import { Box, Button, Container, TextField, Typography, Paper, Chip, Stack, MenuItem } from '@mui/material'

const templates = ['base', 'ai_compute', 'on_orbit_servicing']
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://127.0.0.1:5071'
  : `http://${window.location.hostname}:5071`

export default function App() {
  const [intent, setIntent] = useState('earth_observation')
  const [stakeholders, setStakeholders] = useState('operations, science, ground segment')
  const [template, setTemplate] = useState('base')
  const [autonomy, setAutonomy] = useState(2)
  const [comms, setComms] = useState('store-and-forward')
  const [maxMass, setMaxMass] = useState(200)
  const [maxPower, setMaxPower] = useState(500)
  const [downlink, setDownlink] = useState(5)
  const [phases, setPhases] = useState<string[]>(['Launch','Commissioning','Ops','EOL'])
  const [newPhase, setNewPhase] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [exportResult, setExportResult] = useState<any>(null)
  const [projectName, setProjectName] = useState('')
  const [projects, setProjects] = useState<any[]>([])
  const [status, setStatus] = useState<string>('')

  const addPhase = () => {
    if (!newPhase.trim()) return
    setPhases([...phases, newPhase.trim()])
    setNewPhase('')
  }

  const movePhase = (from: number, to: number) => {
    const next = [...phases]
    const [m] = next.splice(from,1)
    next.splice(to,0,m)
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
      method:'POST',
      headers:{'Content-Type':'application/json'},
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
    setPhases(d.phases.map((p:any)=>p.name))
  }

  const buildPayload = () => ({
    intent, stakeholders,
    template,
    autonomy_level: autonomy,
    comms_policy: comms,
    max_mass_kg: maxMass,
    max_power_w: maxPower,
    downlink_gb_per_day: downlink,
    phases: phases.map((p,i)=>({name:p, order:i}))
  })

  const exportSpec = async () => {
    try {
      setStatus('Exporting...')
      const payload = buildPayload()
      const res = await fetch(`${API_BASE}/export`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
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
    } catch (e:any) {
      setStatus(`Export error: ${e?.message || e}`)
    }
  }

  return (
    <Container maxWidth="md" sx={{py:4}}>
      <Typography variant="h4" gutterBottom>ConOps Builder v2</Typography>
      <Paper sx={{p:2, mb:3}}>
        <Typography variant="h6">Intent + Stakeholders</Typography>
        <TextField fullWidth label="Mission intent" sx={{mt:1}} value={intent} onChange={e=>setIntent(e.target.value)} />
        <TextField fullWidth label="Stakeholders" sx={{mt:2}} value={stakeholders} onChange={e=>setStakeholders(e.target.value)} />
      </Paper>

      <Paper sx={{p:2, mb:3}}>
        <Typography variant="h6">Phases Timeline</Typography>
        <Stack direction="row" spacing={1} sx={{flexWrap:'wrap', mt:1}}>
          {phases.map((p,i)=> (
            <Chip key={i} label={p} draggable
              onDragStart={()=>setDragIndex(i)}
              onDragOver={(e)=>e.preventDefault()}
              onDrop={()=>{ if(dragIndex===null) return; movePhase(dragIndex, i); setDragIndex(null); }}
              onClick={()=> i>0 && movePhase(i, i-1)} onDelete={()=> i<phases.length-1 && movePhase(i, i+1)} />
          ))}
        </Stack>
        <Box sx={{display:'flex', gap:1, mt:2}}>
          <TextField label="New phase" value={newPhase} onChange={e=>setNewPhase(e.target.value)} />
          <Button variant="contained" onClick={addPhase}>Add Phase</Button>
        </Box>
        <Typography variant="caption" color="text.secondary">Click chip to move left. Use delete icon to move right.</Typography>
      </Paper>

      <Paper sx={{p:2, mb:3}}>
        <Typography variant="h6">Objectives (Template)</Typography>
        <TextField select label="Template" value={template} onChange={e=>setTemplate(e.target.value)} sx={{mt:1}}>
          {templates.map(t=>(<MenuItem key={t} value={t}>{t}</MenuItem>))}
        </TextField>
      </Paper>

      
      <Paper sx={{p:2, mb:3}}>
        <Typography variant="h6">Project Storage</Typography>
        <Stack direction="row" spacing={2} sx={{mt:1}}>
          <TextField label="Project name" value={projectName} onChange={e=>setProjectName(e.target.value)} />
          <Button variant="outlined" onClick={saveProject}>Save Project</Button>
          <Button variant="outlined" onClick={fetchProjects}>Refresh List</Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{mt:2, flexWrap:'wrap'}}>
          {projects.map(p=> (
            <Button key={p.id} onClick={()=>loadProject(p.id)} variant="text">Load: {p.name}</Button>
          ))}
        </Stack>
      </Paper>
<Paper sx={{p:2, mb:3}}>
        <Typography variant="h6">Policies + Constraints</Typography>
        <Stack direction="row" spacing={2} sx={{mt:1}}>
          <TextField type="number" label="Autonomy level" value={autonomy} onChange={e=>setAutonomy(parseInt(e.target.value))} />
          <TextField label="Comms policy" value={comms} onChange={e=>setComms(e.target.value)} />
        </Stack>
        <Stack direction="row" spacing={2} sx={{mt:2}}>
          <TextField type="number" label="Max mass (kg)" value={maxMass} onChange={e=>setMaxMass(parseFloat(e.target.value))} />
          <TextField type="number" label="Max power (W)" value={maxPower} onChange={e=>setMaxPower(parseFloat(e.target.value))} />
          <TextField type="number" label="Downlink GB/day" value={downlink} onChange={e=>setDownlink(parseFloat(e.target.value))} />
        </Stack>
      </Paper>

      <Button variant="contained" onClick={exportSpec}>Export mission.yaml + patch + summary</Button>
      {status && <Typography sx={{mt:1}}>{status}</Typography>}

      {exportResult && (
        <Paper sx={{p:2, mt:3}}>
          <Typography variant="h6">Export Result</Typography>
          <Stack direction="row" spacing={2} sx={{mb:2}}>
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
