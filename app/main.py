from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from typing import List, Optional, Dict
from datetime import datetime
from sqlmodel import SQLModel, Field as SQLField, create_engine, Session, select
import json
from pathlib import Path
import yaml

BASE = Path('/home/shamsu/.openclaw/workspace/conops-builder-v2')
DATA = BASE / 'data'
DATA.mkdir(exist_ok=True)
DB_PATH = DATA / 'conops.db'
EXPORTS = DATA / 'exports'
EXPORTS.mkdir(exist_ok=True)
BASE_SPEC = Path('/home/shamsu/.openclaw/workspace/trade-space-kit/configs/mission.yaml')
WORKSPACE_PROJECTS = Path('/home/shamsu/.openclaw/workspace/projects')
WORKSPACE_PROJECTS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title='ConOps Builder v2')

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = create_engine(f"sqlite:///{DB_PATH}")

class Phase(BaseModel):
    name: str
    order: int
    duration: float = Field(default=1, gt=0)

class Window(BaseModel):
    name: str
    start: float
    end: float

    @model_validator(mode='after')
    def validate_range(self):
        if self.end <= self.start:
            raise ValueError('window.end must be > window.start')
        return self

class WindowMask(BaseModel):
    name: str
    start: float
    end: float
    mode: str = 'allow'  # allow | deny
    source_type: str = 'ground_contact'
    source_ref: str = ''

    @model_validator(mode='after')
    def validate_mask(self):
        if self.end <= self.start:
            raise ValueError('window_mask.end must be > window_mask.start')
        if self.mode not in {'allow', 'deny'}:
            raise ValueError("window_mask.mode must be 'allow' or 'deny'")
        return self

class SourceRule(BaseModel):
    name: str
    mode: str = 'allow'  # allow | deny
    source_type: str = 'ground_contact'
    source_ref: str = ''

    @model_validator(mode='after')
    def validate_rule(self):
        if self.mode not in {'allow', 'deny'}:
            raise ValueError("source_rule.mode must be 'allow' or 'deny'")
        return self

class ManualTimeBlock(BaseModel):
    name: str
    start: float
    end: float
    mode: str = 'allow'
    source_type: str = 'manual'

    @model_validator(mode='after')
    def validate_block(self):
        if self.end <= self.start:
            raise ValueError('manual_time_block.end must be > manual_time_block.start')
        if self.mode not in {'allow', 'deny'}:
            raise ValueError("manual_time_block.mode must be 'allow' or 'deny'")
        return self

class Activity(BaseModel):
    name: str
    activity_type: str = ''
    start: float
    duration: float = Field(default=1, gt=0)
    row: int = 0

class RequirementRule(BaseModel):
    activity_type: str
    rule: str
    threshold: str = ''

class PhasePolicyOverride(BaseModel):
    phase: str
    autonomy_level: Optional[int] = None
    comms_policy: Optional[str] = None

class ConOpsInput(BaseModel):
    intent: str
    stakeholders: str
    stakeholder_needs_summary: str = ''
    phases: List[Phase]
    windows: List[Window] = []
    window_masks: List[WindowMask] = []  # legacy payload compatibility
    source_rules: List[SourceRule] = []
    manual_time_blocks: List[ManualTimeBlock] = []
    activities: List[Activity] = []
    requirement_rules: List[RequirementRule] = []
    phase_policy_overrides: List[PhasePolicyOverride] = []
    timeline_rows: List[str] = []
    template: str = 'base'
    autonomy_level: int = 2
    comms_policy: str = 'store-and-forward'
    max_mass_kg: float = 200
    max_power_w: float = 500
    downlink_gb_per_day: float = 5

class ConOpsProject(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    name: str
    data: str  # json
    created_at: datetime = Field(default_factory=datetime.utcnow)


def deep_merge(base, patch):
    if isinstance(base, dict) and isinstance(patch, dict):
        out = dict(base)
        for k,v in patch.items():
            out[k] = deep_merge(out.get(k), v)
        return out
    return patch if patch is not None else base


def conops_from_tradespace(ts: dict, fallback: dict | None = None):
    fallback = fallback or {}
    mission = (ts or {}).get('mission', {}) or {}
    constraints = mission.get('constraints', {}) or {}
    ops = (ts or {}).get('ops_timeline', {}) or {}
    contract = (ts or {}).get('operational_contract', {}) or {}
    phase_policies = (contract.get('phase_policies', {}) or {})

    out = {
        'intent': mission.get('intent', fallback.get('intent', 'earth_observation')),
        'stakeholders': contract.get('stakeholders', fallback.get('stakeholders', '')),
        'stakeholder_needs_summary': contract.get('stakeholder_needs_summary', fallback.get('stakeholder_needs_summary', '')),
        'phases': ops.get('phases') or fallback.get('phases') or [{'name': 'Routine Operations', 'order': 0, 'duration': 30.0}],
        'windows': fallback.get('windows', []),
        'window_masks': fallback.get('window_masks', []),
        'source_rules': contract.get('window_sources') or fallback.get('source_rules') or [],
        'manual_time_blocks': ops.get('manual_time_blocks') or fallback.get('manual_time_blocks') or [],
        'activities': ops.get('activities') or fallback.get('activities') or [],
        'requirement_rules': contract.get('activity_gating_rules') or fallback.get('requirement_rules') or [],
        'phase_policy_overrides': phase_policies.get('overrides') or fallback.get('phase_policy_overrides') or [],
        'timeline_rows': ops.get('timeline_rows') or fallback.get('timeline_rows') or [],
        'template': ((ts or {}).get('study', {}) or {}).get('profile', fallback.get('template', 'base')),
        'autonomy_level': phase_policies.get('autonomy_level', constraints.get('autonomy_level', fallback.get('autonomy_level', 2))),
        'comms_policy': phase_policies.get('comms_policy', fallback.get('comms_policy', 'store-and-forward')),
        'max_mass_kg': constraints.get('max_mass_kg', fallback.get('max_mass_kg', 200)),
        'max_power_w': constraints.get('max_power_w', fallback.get('max_power_w', 500)),
        'downlink_gb_per_day': constraints.get('downlink_gb_per_day', fallback.get('downlink_gb_per_day', 5)),
    }
    return out


def build_patch(spec: ConOpsInput):
    # compatibility: if old window_masks are sent, treat zero/non-positive ranges as source rules and valid ranges as manual blocks
    legacy_masks = spec.window_masks or []
    source_rules = spec.source_rules or []
    manual_blocks = spec.manual_time_blocks or []
    if not source_rules and not manual_blocks and legacy_masks:
        for w in legacy_masks:
            if w.end > w.start:
                manual_blocks.append(ManualTimeBlock(name=w.name, start=w.start, end=w.end, mode=w.mode, source_type=w.source_type))
            else:
                source_rules.append(SourceRule(name=w.name, mode=w.mode, source_type=w.source_type, source_ref=w.source_ref))

    return {
        "study": {"profile": spec.template},
        "mission": {
            "intent": spec.intent,
            "constraints": {
                "max_mass_kg": spec.max_mass_kg,
                "max_power_w": spec.max_power_w,
                "downlink_gb_per_day": spec.downlink_gb_per_day,
                "autonomy_level": spec.autonomy_level,
            },
        },
        "ops_timeline": {
            "phases": [p.model_dump() for p in spec.phases],
            "manual_time_blocks": [w.model_dump() for w in manual_blocks],
            "activities": [a.model_dump() for a in spec.activities],
            "timeline_rows": spec.timeline_rows,
        },
        "operational_contract": {
            "intent": spec.intent,
            "stakeholders": spec.stakeholders,
            "stakeholder_needs_summary": spec.stakeholder_needs_summary,
            "objectives": {"profile": spec.template},
            "phase_policies": {
                "autonomy_level": spec.autonomy_level,
                "comms_policy": spec.comms_policy,
                "overrides": [o.model_dump() for o in spec.phase_policy_overrides],
            },
            "window_sources": [w.model_dump() for w in source_rules],
            "activity_gating_rules": [r.model_dump() for r in spec.requirement_rules],
            "traceability": {
                "notes": "Declarative ConOps contract; TradeSpaceKit computes feasibility/windows per design point."
            }
        }
    }


def build_full_spec(spec: ConOpsInput):
    patch = build_patch(spec)
    if BASE_SPEC.exists():
        base = yaml.safe_load(BASE_SPEC.read_text())
        merged = deep_merge(base, patch)
        merged.setdefault("study", {})["notes"] = "Generated by ConOps Builder v2"
        return merged
    return patch


def ensure_db():
    SQLModel.metadata.create_all(engine)


@app.on_event("startup")
def on_startup():
    ensure_db()


@app.get('/health')
def health():
    return {"ok": True}


@app.post('/projects')
def save_project(name: str, spec: ConOpsInput):
    data = spec.model_dump()
    with Session(engine) as s:
        rows = s.exec(select(ConOpsProject)).all()
        same = [r for r in rows if r.name == name]
        if same:
            # keep newest, update it, remove stale duplicates
            same.sort(key=lambda r: (r.created_at, r.id or 0), reverse=True)
            obj = same[0]
            obj.data = json.dumps(data)
            obj.created_at = datetime.utcnow()
            s.add(obj)
            for stale in same[1:]:
                s.delete(stale)
            s.commit()
            s.refresh(obj)
            return {"id": obj.id, "updated": True, "deduped": len(same)-1}
        obj = ConOpsProject(name=name, data=json.dumps(data))
        s.add(obj)
        s.commit()
        s.refresh(obj)
    return {"id": obj.id, "updated": False, "deduped": 0}


@app.get('/projects')
def list_projects():
    with Session(engine) as s:
        rows = s.exec(select(ConOpsProject).order_by(ConOpsProject.created_at.desc())).all()
    return [{"id": r.id, "name": r.name, "created_at": r.created_at} for r in rows]




@app.get('/projects/{project_id}')
def get_project(project_id: int):
    with Session(engine) as s:
        obj = s.get(ConOpsProject, project_id)
        if not obj:
            return {"error": "not found"}
    return {"id": obj.id, "name": obj.name, "data": json.loads(obj.data)}


@app.get('/download/{name}')
def download(name: str):
    path = EXPORTS / name
    if not path.exists():
        return {"error": "not found"}
    return FileResponse(path)
@app.get('/workspace/projects')
def workspace_projects():
    out = []
    for d in sorted([p for p in WORKSPACE_PROJECTS.iterdir() if p.is_dir()]):
        meta = d / 'project.yaml'
        updated = None
        if meta.exists():
            try:
                m = yaml.safe_load(meta.read_text()) or {}
                updated = m.get('updated_at')
            except Exception:
                pass
        conops = d / 'conops.yaml'
        tradespace = d / 'tradespace.yaml'
        sync = 'unknown'
        if conops.exists() and tradespace.exists():
            dc = conops.stat().st_mtime
            dt = tradespace.stat().st_mtime
            if abs(dc - dt) < 1:
                sync = 'in-sync'
            elif dc > dt:
                sync = 'conops-newer'
            else:
                sync = 'tradespace-newer'
        out.append({'name': d.name, 'path': str(d), 'updated_at': updated, 'sync': sync})
    return out


@app.post('/workspace/save')
def workspace_save(name: str, spec: ConOpsInput):
    pdir = WORKSPACE_PROJECTS / name
    pdir.mkdir(parents=True, exist_ok=True)
    conops_doc = spec.model_dump()
    tradespace_doc = build_full_spec(spec)
    (pdir / 'conops.yaml').write_text(yaml.safe_dump(conops_doc, sort_keys=False))
    (pdir / 'tradespace.yaml').write_text(yaml.safe_dump(tradespace_doc, sort_keys=False))
    meta = {
        'name': name,
        'updated_at': datetime.utcnow().isoformat(),
        'files': {
            'conops': 'conops.yaml',
            'tradespace': 'tradespace.yaml'
        }
    }
    (pdir / 'project.yaml').write_text(yaml.safe_dump(meta, sort_keys=False))
    return {'ok': True, 'project': name, 'path': str(pdir)}


@app.get('/workspace/load/{name}')
def workspace_load(name: str):
    pdir = WORKSPACE_PROJECTS / name
    if not pdir.exists():
        return {'error': 'not found'}
    conops_path = pdir / 'conops.yaml'
    tradespace_path = pdir / 'tradespace.yaml'
    out = {'name': name, 'path': str(pdir), 'tradespace_path': str(tradespace_path)}

    conops_doc = yaml.safe_load(conops_path.read_text()) if conops_path.exists() else {}
    tradespace_doc = yaml.safe_load(tradespace_path.read_text()) if tradespace_path.exists() else {}

    # Authoritative load for trade-sync flow: if tradespace exists, hydrate ConOps UI from it.
    if isinstance(tradespace_doc, dict) and tradespace_doc:
        out['conops'] = conops_from_tradespace(tradespace_doc, conops_doc if isinstance(conops_doc, dict) else {})
        out['source'] = 'tradespace'
    elif isinstance(conops_doc, dict) and conops_doc:
        out['conops'] = conops_doc
        out['source'] = 'conops'

    return out


@app.post('/export')
def export_spec(spec: ConOpsInput):
    ts = datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    full = build_full_spec(spec)
    patch = build_patch(spec)
    mission_path = EXPORTS / f"mission-{ts}.yaml"
    patch_path = EXPORTS / f"conops-patch-{ts}.yaml"
    summary_path = EXPORTS / f"conops-summary-{ts}.md"
    mission_path.write_text(yaml.safe_dump(full, sort_keys=False))
    patch_path.write_text(yaml.safe_dump(patch, sort_keys=False))
    summary = (
        f"# ConOps Summary\n\n"
        f"**Intent:** {spec.intent}\n\n"
        f"**Stakeholders:** {spec.stakeholders}\n\n"
        f"**Stakeholder needs summary:** {spec.stakeholder_needs_summary}\n\n"
        f"**Template:** {spec.template}\n\n"
        f"**Policies:**\n- Autonomy level: {spec.autonomy_level}\n- Comms policy: {spec.comms_policy}\n\n"
        f"**Constraints:**\n- Max mass: {spec.max_mass_kg} kg\n- Max power: {spec.max_power_w} W\n- Downlink: {spec.downlink_gb_per_day} GB/day\n\n"
        f"**Phases:**\n" + "\n".join([f"- {p.name} (duration={p.duration})" for p in sorted(spec.phases, key=lambda x: x.order)]) + "\n\n"
        f"**Window Source Rules:**\n" + ("\n".join([f"- {w.name}: {w.mode} ({w.source_type})" for w in spec.source_rules]) if spec.source_rules else "- None") + "\n\n"
        f"**Gating Rules:**\n" + ("\n".join([f"- {r.activity_type}: {r.rule} {r.threshold}" for r in spec.requirement_rules]) if spec.requirement_rules else "- None") + "\n"
    )
    summary_path.write_text(summary)
    return {"mission": mission_path.name, "patch": patch_path.name, "summary": summary_path.name}
