import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paragraphDiff } from "./text-diff.mjs";
import { extractChapter as chapterExtraction,groundedFacts as localFacts,EXTRACTION_VERSION } from "./story-evidence.mjs";
import { rankMemory } from "./memory-retrieval.mjs";

const nowIso = () => new Date().toISOString();
const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const stableId = (...parts) => hash(parts.join("\u001f"));
const aliasSignature = value => clean(value).replace(/(红|黑|白|蓝|绿|黄|紫|灰)色/g,"$1").replace(/雨伞/g,"伞").replace(/[的之]/g,"").toLowerCase();

function splitForProject(projectId) {
  const bucket = Number.parseInt(hash(projectId).slice(0, 8), 16) % 10;
  return bucket === 0 ? "test" : bucket === 1 ? "validation" : "train";
}

export function vectorize(text, dimensions=192) {
  const vector = Array(dimensions).fill(0);
  const normalized = clean(text).toLowerCase();
  const tokens = [...normalized.matchAll(/[\p{Script=Han}]|[a-z0-9_]+/gu)].map(match => match[0]);
  for (let index=0; index<tokens.length; index++) {
    const digest=createHash("sha256").update(`${tokens[index]}:${tokens[index+1] || ""}`).digest();
    const slot=digest.readUInt16BE(0)%dimensions;
    vector[slot]+=digest[2]%2 ? 1 : -1;
  }
  const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0))||1;
  return vector.map(value=>value/norm);
}

export function cosine(left, right) {
  let score=0;
  for (let index=0; index<Math.min(left.length,right.length); index++) score+=left[index]*right[index];
  return score;
}

function chapterNumber(label,fallback) {
  const value=label.trim();
  if(/^\d+$/.test(value))return Number(value);
  if(!/^[零〇一二两三四五六七八九十百千万]+$/.test(value))return fallback;
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000,万:10000};
  let total=0,section=0,number=0;
  for(const character of value){if(character in digits)number=digits[character];else if(units[character]===10000){total+=(section+number)*10000;section=0;number=0}else{section+=(number||1)*units[character];number=0}}
  return total+section+number;
}

function chaptersFromDraft(draft) {
  const source=String(draft || "");
  const matches=[...source.matchAll(/^#{0,3}\s*第([^\n]{1,16}?)章[^\n]*$/gm)];
  if (!matches.length) return source.trim() ? [{ chapter:1, text:source.trim() }] : [];
  return matches.map((match,index)=>({ chapter:chapterNumber(match[1],index+1), text:source.slice(match.index,matches[index+1]?.index ?? source.length).trim() }));
}

function draftSegments(draft) {
  const source=String(draft || ""),matches=[...source.matchAll(/^#{0,3}\s*第([^\n]{1,16}?)章[^\n]*$/gm)];
  if (!matches.length) return { prefix:"",segments:source ? [{chapter:1,text:source}] : [] };
  return { prefix:source.slice(0,matches[0].index),segments:matches.map((match,index)=>({chapter:index+1,text:source.slice(match.index,matches[index+1]?.index ?? source.length)})) };
}


export class PlatformStore {
  constructor({ dbPath }) {
    mkdirSync(dirname(dbPath), { recursive:true });
    this.db=new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'author', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_owners (project_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS story_chunks (project_id TEXT NOT NULL, chapter INTEGER NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, vector_json TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,chapter,chunk_index));
      CREATE INDEX IF NOT EXISTS idx_story_chunks_project ON story_chunks(project_id,chapter);
      CREATE TABLE IF NOT EXISTS story_facts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_story_facts_project_kind ON story_facts(project_id,kind,chapter);
      CREATE TABLE IF NOT EXISTS story_entities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, first_chapter INTEGER NOT NULL, last_chapter INTEGER NOT NULL, attributes_json TEXT NOT NULL DEFAULT '{}', UNIQUE(project_id,name));
      CREATE INDEX IF NOT EXISTS idx_story_entities_project ON story_entities(project_id,type,name);
      CREATE TABLE IF NOT EXISTS story_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, sequence INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_story_events_project ON story_events(project_id,chapter,sequence);
      CREATE TABLE IF NOT EXISTS story_timeline (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, sequence INTEGER NOT NULL, time_label TEXT NOT NULL, location TEXT NOT NULL, event_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_story_timeline_project ON story_timeline(project_id,chapter,sequence);
      CREATE TABLE IF NOT EXISTS dataset_samples (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, task TEXT NOT NULL, input_text TEXT NOT NULL, output_text TEXT NOT NULL, license TEXT NOT NULL, split TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, consent_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_dataset_samples_split ON dataset_samples(split,task);
      CREATE TABLE IF NOT EXISTS training_runs (id TEXT PRIMARY KEY, type TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, dataset_path TEXT, remote_job_id TEXT, metrics_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_calls (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, mode TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, request_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at,user_id);
      CREATE TABLE IF NOT EXISTS quality_observations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_quality_observations_metric ON quality_observations(metric,created_at);
      CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, severity TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS chapter_records (project_id TEXT NOT NULL, chapter INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, state_changes_json TEXT NOT NULL, paragraphs_json TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,chapter));
      CREATE TABLE IF NOT EXISTS story_evidence (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, paragraph INTEGER NOT NULL, category TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_story_evidence_scope ON story_evidence(project_id,chapter,category,subject);
      CREATE TABLE IF NOT EXISTS story_characters (project_id TEXT NOT NULL, name TEXT NOT NULL, latest_state_json TEXT NOT NULL, last_chapter INTEGER NOT NULL, PRIMARY KEY(project_id,name));
      CREATE TABLE IF NOT EXISTS story_items (project_id TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, last_chapter INTEGER NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(project_id,name));
      CREATE TABLE IF NOT EXISTS story_clues (project_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, introduced_chapter INTEGER, resolved_chapter INTEGER, evidence_json TEXT NOT NULL, PRIMARY KEY(project_id,name));
      CREATE TABLE IF NOT EXISTS story_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, character TEXT NOT NULL, fact TEXT NOT NULL, status TEXT NOT NULL, chapter INTEGER NOT NULL, paragraph INTEGER NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_story_knowledge_character ON story_knowledge(project_id,character,chapter);
      CREATE TABLE IF NOT EXISTS contradiction_findings (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL, start_chapter INTEGER NOT NULL, end_chapter INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_contradictions_project_scope ON contradiction_findings(project_id,scope,created_at);
      CREATE TABLE IF NOT EXISTS review_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL, start_chapter INTEGER NOT NULL, end_chapter INTEGER NOT NULL, findings_json TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_versions (project_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, changed_modules_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,revision));
      CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id,revision DESC);
      CREATE TABLE IF NOT EXISTS chapter_metrics (project_id TEXT NOT NULL, chapter INTEGER NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, latency_ms INTEGER NOT NULL, retries INTEGER NOT NULL, request_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(project_id,chapter));
      CREATE TABLE IF NOT EXISTS reader_evaluations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, reviewer_id TEXT NOT NULL, continue_reading INTEGER NOT NULL, interest_character TEXT NOT NULL, lost_interest TEXT NOT NULL, confusion TEXT NOT NULL, prediction TEXT NOT NULL, machine_like INTEGER NOT NULL, time_commitment_minutes INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,chapter,reviewer_id));
      CREATE TABLE IF NOT EXISTS blind_review_sessions (code TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS dataset_quality (sample_id TEXT PRIMARY KEY, quality_score INTEGER NOT NULL, review_notes TEXT NOT NULL, approved INTEGER NOT NULL, reviewed_at TEXT NOT NULL, FOREIGN KEY(sample_id) REFERENCES dataset_samples(id));
      CREATE TABLE IF NOT EXISTS canonical_chapters (project_id TEXT NOT NULL, chapter INTEGER NOT NULL, revision INTEGER NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'final', updated_at TEXT NOT NULL, PRIMARY KEY(project_id,chapter));
      CREATE INDEX IF NOT EXISTS idx_canonical_chapters_project ON canonical_chapters(project_id,chapter);
      CREATE TABLE IF NOT EXISTS entity_aliases (project_id TEXT NOT NULL, entity_type TEXT NOT NULL, canonical_name TEXT NOT NULL, alias TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(project_id,entity_type,alias));
      CREATE INDEX IF NOT EXISTS idx_entity_aliases_signature ON entity_aliases(project_id,entity_type,signature);
      CREATE TABLE IF NOT EXISTS content_blobs (content_hash TEXT PRIMARY KEY, content_type TEXT NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_version_manifests (project_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,revision));
      CREATE TABLE IF NOT EXISTS model_call_attempts (id TEXT PRIMARY KEY, call_group_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT, mode TEXT NOT NULL, attempt INTEGER NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, usage_known INTEGER NOT NULL DEFAULT 0, request_id TEXT, output_cap INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_model_call_attempts_group ON model_call_attempts(call_group_id,attempt);
      CREATE TABLE IF NOT EXISTS generation_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, requested_chapters INTEGER NOT NULL, completed_chapters INTEGER NOT NULL DEFAULT 0, start_chapter INTEGER NOT NULL DEFAULT 1, next_chapter INTEGER NOT NULL, expected_revision INTEGER NOT NULL, last_error TEXT, active_response_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chapter_candidates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_chapter_candidates_project ON chapter_candidates(project_id,chapter,created_at);
      CREATE TABLE IF NOT EXISTS story_observations (project_id TEXT NOT NULL,chapter INTEGER NOT NULL,source_hash TEXT NOT NULL,extractor_version TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(project_id,chapter));
      CREATE TABLE IF NOT EXISTS story_identities (project_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,aliases_json TEXT NOT NULL,PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS project_heads (project_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chapter_commits (candidate_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,chapter INTEGER NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_operations (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_requests (request_id TEXT NOT NULL,user_id TEXT NOT NULL,job_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(user_id,request_id));
      CREATE TABLE IF NOT EXISTS job_model_configs (job_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
    `);
    const jobColumns=this.db.prepare("PRAGMA table_info(generation_jobs)").all().map(item=>item.name);
    if (!jobColumns.includes("start_chapter")) this.db.exec("ALTER TABLE generation_jobs ADD COLUMN start_chapter INTEGER NOT NULL DEFAULT 1");
    this.db.prepare("UPDATE generation_jobs SET status='paused',last_error=COALESCE(last_error,'服务重启后等待继续'),updated_at=? WHERE status='running'").run(nowIso());
    this.db.exec("PRAGMA optimize");
  }

  ensureUser(userId, role="author") {
    this.db.prepare("INSERT OR IGNORE INTO users(id,role,created_at) VALUES(?,?,?)").run(userId,role,nowIso());
  }

  saveChapterCandidate(candidate){
    const stored={...candidate,id:randomUUID(),createdAt:nowIso()};
    this.db.prepare("INSERT INTO chapter_candidates(id,project_id,chapter,payload_json,created_at) VALUES(?,?,?,?,?)").run(stored.id,stored.projectId,stored.chapter,JSON.stringify(stored),stored.createdAt);
    return {...stored,diff:paragraphDiff(stored.originalText,stored.revisedText)};
  }
  chapterCandidate(id){const row=this.db.prepare("SELECT payload_json FROM chapter_candidates WHERE id=?").get(id);if(!row)return null;const value=JSON.parse(row.payload_json);return {...value,diff:paragraphDiff(value.originalText,value.revisedText)};}
  latestChapterCandidate(projectId,chapter){const row=this.db.prepare("SELECT id FROM chapter_candidates WHERE project_id=? AND chapter=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(projectId,chapter);return row?this.chapterCandidate(row.id):null;}

  owner(projectId) { return this.db.prepare("SELECT user_id FROM project_owners WHERE project_id=?").get(projectId)?.user_id || null; }
  claimProject(projectId,userId) {
    this.ensureUser(userId);
    const owner=this.owner(projectId);
    if (owner && owner!==userId) return false;
    this.db.prepare("INSERT OR IGNORE INTO project_owners(project_id,user_id,created_at) VALUES(?,?,?)").run(projectId,userId,nowIso());
    return true;
  }

  indexProject(project) {
    const projectId=project.projectId;
    const chapters=chaptersFromDraft(project.content?.draft);
    const ownTransaction=!this.db.isTransaction;
    if(ownTransaction)this.db.exec("BEGIN IMMEDIATE");
    try {
      this.registerIdentities(project);
      this.db.prepare("DELETE FROM story_chunks WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_facts WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_entities WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_events WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_timeline WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM chapter_records WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_evidence WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_characters WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_items WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_clues WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_knowledge WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM canonical_chapters WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM entity_aliases WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM story_observations WHERE project_id=?").run(projectId);
      for (const item of chapters) this.processChapter({ projectId,chapter:item.chapter,text:item.text,revision:Number(project.revision)||0 });
      if(ownTransaction)this.db.exec("COMMIT");
    } catch (error) { if(ownTransaction)this.db.exec("ROLLBACK"); throw error; }
    return { chapters:chapters.length, chunks:this.db.prepare("SELECT COUNT(*) count FROM story_chunks WHERE project_id=?").get(projectId).count, facts:this.db.prepare("SELECT COUNT(*) count FROM story_facts WHERE project_id=?").get(projectId).count,entities:this.db.prepare("SELECT COUNT(*) count FROM story_entities WHERE project_id=?").get(projectId).count,events:this.db.prepare("SELECT COUNT(*) count FROM story_events WHERE project_id=?").get(projectId).count,timeline:this.db.prepare("SELECT COUNT(*) count FROM story_timeline WHERE project_id=?").get(projectId).count,characters:this.db.prepare("SELECT COUNT(*) count FROM story_characters WHERE project_id=?").get(projectId).count,items:this.db.prepare("SELECT COUNT(*) count FROM story_items WHERE project_id=?").get(projectId).count,clues:this.db.prepare("SELECT COUNT(*) count FROM story_clues WHERE project_id=?").get(projectId).count,knowledge:this.db.prepare("SELECT COUNT(*) count FROM story_knowledge WHERE project_id=?").get(projectId).count };
  }

  ensureProjectIndexed(project) {
    this.registerIdentities(project);
    const chapters=chaptersFromDraft(project?.content?.draft),projectId=project.projectId;
    const stored=this.db.prepare("SELECT chapter,content_hash FROM canonical_chapters WHERE project_id=? ORDER BY chapter").all(projectId);
    const versionCount=this.db.prepare("SELECT COUNT(*) n FROM story_observations WHERE project_id=? AND extractor_version=?").get(projectId,EXTRACTION_VERSION).n;
    const current=versionCount===chapters.length&&stored.length===chapters.length&&stored.every((row,index)=>row.chapter===chapters[index].chapter&&row.content_hash===hash(chapters[index].text));
    return current ? { current:true,chapters:stored.length } : { current:false,...this.indexProject(project) };
  }

  canonicalName(projectId,entityType,name) {
    const alias=clean(name),signature=aliasSignature(alias);
    if (!alias) return alias;
    const existing=this.db.prepare("SELECT canonical_name FROM entity_aliases WHERE project_id=? AND entity_type=? AND signature=? ORDER BY LENGTH(canonical_name) DESC LIMIT 1").get(projectId,entityType,signature);
    const registered=entityType==="character"?this.identities(projectId).find(item=>item.name===alias||item.aliases.includes(alias)):null;
    const canonical=registered?.name || existing?.canonical_name || alias;
    this.db.prepare("INSERT OR REPLACE INTO entity_aliases(project_id,entity_type,canonical_name,alias,signature) VALUES(?,?,?,?,?)").run(projectId,entityType,canonical,alias,signature);
    return canonical;
  }

  rebuildDerivedState(projectId) {
    this.db.prepare("DELETE FROM story_entities WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM story_characters WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM story_items WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM story_clues WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM story_knowledge WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM entity_aliases WHERE project_id=?").run(projectId);
    const addEntity=this.db.prepare("INSERT INTO story_entities(id,project_id,name,type,first_chapter,last_chapter,attributes_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,name) DO UPDATE SET first_chapter=MIN(first_chapter,excluded.first_chapter),last_chapter=MAX(last_chapter,excluded.last_chapter)");
    for (const fact of this.db.prepare("SELECT chapter,kind,subject,object FROM story_facts WHERE project_id=? ORDER BY chapter").all(projectId)) {
      if (fact.subject!=="章节") addEntity.run(stableId(projectId,"entity","character",fact.subject),projectId,fact.subject,"character",fact.chapter,fact.chapter,"{}");
      if (fact.kind==="location") addEntity.run(stableId(projectId,"entity","location",fact.object),projectId,fact.object,"location",fact.chapter,fact.chapter,"{}");
      if (fact.kind==="item") addEntity.run(stableId(projectId,"entity","item",fact.object),projectId,fact.object,"item",fact.chapter,fact.chapter,"{}");
    }
    const evidence=this.db.prepare("SELECT id,chapter,paragraph,category,subject,predicate,object,evidence FROM story_evidence WHERE project_id=? ORDER BY chapter,paragraph,rowid").all(projectId);
    for (const record of evidence) {
      if (record.category==="character") {
        const character=this.canonicalName(projectId,"character",record.subject);
        const current=this.db.prepare("SELECT latest_state_json FROM story_characters WHERE project_id=? AND name=?").get(projectId,character);
        const state=current ? JSON.parse(current.latest_state_json) : {};
        state[record.predicate]=record.object;
        this.db.prepare("INSERT OR REPLACE INTO story_characters(project_id,name,latest_state_json,last_chapter) VALUES(?,?,?,?)").run(projectId,character,JSON.stringify(state),record.chapter);
      }
      if (record.category==="item") {
        const item=this.canonicalName(projectId,"item",record.subject),owner=this.canonicalName(projectId,"character",record.object);
        this.db.prepare("INSERT OR REPLACE INTO story_items(project_id,name,owner,status,last_chapter,evidence_id) VALUES(?,?,?,?,?,?)").run(projectId,item,owner,owner==="无"?"无持有人":"持有",record.chapter,record.id);
      }
      if (record.category==="clue") {
        const clue=this.canonicalName(projectId,"clue",record.subject);
        addEntity.run(stableId(projectId,"entity","clue",clue),projectId,clue,"clue",record.chapter,record.chapter,"{}");
        const old=this.db.prepare("SELECT introduced_chapter,resolved_chapter,evidence_json FROM story_clues WHERE project_id=? AND name=?").get(projectId,clue);
        const evidenceList=old ? JSON.parse(old.evidence_json) : [];
        evidenceList.push({chapter:record.chapter,paragraph:record.paragraph,quote:record.evidence});
        const resolved=record.object==="回收" ? record.chapter : old?.resolved_chapter || null;
        this.db.prepare("INSERT OR REPLACE INTO story_clues(project_id,name,status,introduced_chapter,resolved_chapter,evidence_json) VALUES(?,?,?,?,?,?)").run(projectId,clue,resolved ? "resolved" : "open",old?.introduced_chapter || record.chapter,resolved,JSON.stringify(evidenceList));
      }
      if (record.category==="knowledge") {
        const character=this.canonicalName(projectId,"character",record.subject);
        this.db.prepare("INSERT INTO story_knowledge(id,project_id,character,fact,status,chapter,paragraph,evidence) VALUES(?,?,?,?,?,?,?,?)").run(stableId(projectId,"knowledge",record.chapter,record.paragraph,character,record.predicate,record.object),projectId,character,record.object,record.predicate,record.chapter,record.paragraph,record.evidence);
      }
    }
  }

  registerIdentities(project){
    this.db.prepare("DELETE FROM story_identities WHERE project_id=?").run(project.projectId);
    const insert=this.db.prepare("INSERT INTO story_identities(project_id,id,name,aliases_json) VALUES(?,?,?,?)");
    for(const c of project.planning?.bible?.data?.characters||[])insert.run(project.projectId,c.id,c.name,JSON.stringify(c.aliases||[]));
  }
  identities(projectId){return this.db.prepare("SELECT id,name,aliases_json FROM story_identities WHERE project_id=?").all(projectId).map(r=>({id:r.id,name:r.name,aliases:JSON.parse(r.aliases_json)}));}

  processChapter({ projectId,chapter,text,metrics,revision=0 }) {
    const extracted=chapterExtraction(chapter,text),contentHash=hash(text);
    const existing=this.db.prepare("SELECT content_hash FROM canonical_chapters WHERE project_id=? AND chapter=?").get(projectId,chapter);
    const extractionVersion=this.db.prepare("SELECT extractor_version FROM story_observations WHERE project_id=? AND chapter=?").get(projectId,chapter)?.extractor_version;
    if (existing?.content_hash===contentHash&&extractionVersion===EXTRACTION_VERSION) {
      if (metrics) this.recordChapterMetrics({ projectId,chapter,...metrics });
      return { chapter,title:extracted.title,summary:extracted.summary,stateChanges:extracted.stateChanges,paragraphs:extracted.paragraphs.length,idempotent:true };
    }
    const replaceChunk=this.db.prepare("INSERT OR REPLACE INTO story_chunks(project_id,chapter,chunk_index,text,vector_json,content_hash,updated_at) VALUES(?,?,?,?,?,?,?)");
    const addFact=this.db.prepare("INSERT OR REPLACE INTO story_facts(id,project_id,chapter,kind,subject,predicate,object,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
    const addEvent=this.db.prepare("INSERT OR REPLACE INTO story_events(id,project_id,chapter,sequence,actor,action,target,evidence) VALUES(?,?,?,?,?,?,?,?)");
    const addTimeline=this.db.prepare("INSERT OR REPLACE INTO story_timeline(id,project_id,chapter,sequence,time_label,location,event_id) VALUES(?,?,?,?,?,?,?)");
    const addEvidence=this.db.prepare("INSERT OR REPLACE INTO story_evidence(id,project_id,chapter,paragraph,category,subject,predicate,object,evidence) VALUES(?,?,?,?,?,?,?,?,?)");
    const ownTransaction=!this.db.isTransaction;
    if(ownTransaction)this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["story_chunks","story_facts","story_events","story_timeline","story_evidence"]) this.db.prepare(`DELETE FROM ${table} WHERE project_id=? AND chapter=?`).run(projectId,chapter);
      this.db.prepare("INSERT OR REPLACE INTO canonical_chapters(project_id,chapter,revision,text,content_hash,status,updated_at) VALUES(?,?,?,?,?,'final',?)").run(projectId,chapter,revision,String(text),contentHash,nowIso());
      this.db.prepare("INSERT OR REPLACE INTO chapter_records(project_id,chapter,title,summary,state_changes_json,paragraphs_json,content_hash,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(projectId,chapter,extracted.title,extracted.summary,JSON.stringify(extracted.stateChanges),JSON.stringify(extracted.paragraphs),contentHash,nowIso());
      this.db.prepare("INSERT OR REPLACE INTO story_observations(project_id,chapter,source_hash,extractor_version,payload_json) VALUES(?,?,?,?,?)").run(projectId,chapter,contentHash,EXTRACTION_VERSION,JSON.stringify(extracted.observations));
      for (const [index,chunk] of (String(text).match(/[\s\S]{1,3500}/g) || []).entries()) replaceChunk.run(projectId,chapter,index,chunk,JSON.stringify(vectorize(chunk)),hash(chunk),nowIso());
      let sequence=0;
      for (const fact of localFacts(chapter,text)) {
        sequence++;
        const factId=stableId(projectId,"fact",chapter,sequence,fact.kind,fact.subject,fact.object),eventId=stableId(projectId,"event",chapter,sequence);
        addFact.run(factId,projectId,chapter,fact.kind,fact.subject,fact.predicate,fact.object,fact.evidence,nowIso());
        addEvent.run(eventId,projectId,chapter,sequence,fact.subject,fact.predicate,fact.object,fact.evidence);
        addTimeline.run(stableId(projectId,"timeline",chapter,sequence),projectId,chapter,sequence,`第${chapter}章`,fact.kind==="location" ? fact.object : "",eventId);
      }
      for (const record of extracted.records) {
        const evidenceId=stableId(projectId,"evidence",chapter,record.paragraph,record.category,record.subject,record.predicate,record.object,record.evidence);
        addEvidence.run(evidenceId,projectId,chapter,record.paragraph,record.category,record.subject,record.predicate,record.object,record.evidence);
      }
      this.rebuildDerivedState(projectId);
      if(ownTransaction)this.db.exec("COMMIT");
    } catch (error) { if(ownTransaction)this.db.exec("ROLLBACK");throw error; }
    if (metrics) this.recordChapterMetrics({ projectId,chapter,...metrics });
    return { chapter,title:extracted.title,summary:extracted.summary,stateChanges:extracted.stateChanges,paragraphs:extracted.paragraphs.length,idempotent:false };
  }

  recordChapterMetrics(value) {
    this.db.prepare("INSERT OR REPLACE INTO chapter_metrics(project_id,chapter,model,input_tokens,output_tokens,cached_tokens,cost_usd,latency_ms,retries,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(value.projectId,value.chapter,value.model || "unknown",value.inputTokens||0,value.outputTokens||0,value.cachedTokens||0,value.costUsd||0,value.latencyMs||0,value.retries||0,value.requestId||null,nowIso());
  }

  commitProject(project,{candidate=null,text=null}={}){
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const previous=this.projectHead(project.projectId);
      this.saveVersion(project);
      if(candidate){this.processChapter({projectId:project.projectId,chapter:candidate.chapter,text,metrics:candidate.metrics,revision:project.revision});this.db.prepare("INSERT INTO chapter_commits(candidate_id,project_id,chapter,revision) VALUES(?,?,?,?)").run(candidate.id,project.projectId,candidate.chapter,project.revision);}
      else if(previous?.content?.draft!==project.content?.draft||JSON.stringify(previous?.planning?.bible)!==JSON.stringify(project.planning?.bible))this.indexProject(project);
      this.db.prepare("INSERT OR REPLACE INTO project_heads(project_id,revision) VALUES(?,?)").run(project.projectId,project.revision);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  projectHead(projectId){const row=this.db.prepare("SELECT revision FROM project_heads WHERE project_id=?").get(projectId);return row?this.versionSnapshot(projectId,row.revision):null;}
  chapterCommit(candidateId){return this.db.prepare("SELECT * FROM chapter_commits WHERE candidate_id=?").get(candidateId)||null;}
  modelOperation(id){const row=this.db.prepare("SELECT status,payload_json FROM model_operations WHERE id=?").get(id);return row?{status:row.status,...JSON.parse(row.payload_json)}:null;}
  saveModelOperation(id,projectId,mode,status,payload){this.db.prepare("INSERT OR REPLACE INTO model_operations(id,project_id,mode,status,payload_json,updated_at) VALUES(?,?,?,?,?,?)").run(id,projectId,mode,status,JSON.stringify(payload),nowIso());}
  jobRequest(requestId,userId){const row=this.db.prepare("SELECT job_id,project_id FROM job_requests WHERE request_id=? AND user_id=?").get(requestId,userId);return row?{projectId:row.project_id,job:this.generationJob(row.job_id,userId)}:null;}
  rememberJobRequest(requestId,userId,job){this.db.prepare("INSERT OR IGNORE INTO job_requests(request_id,user_id,job_id,project_id) VALUES(?,?,?,?)").run(requestId,userId,job.id,job.projectId);}
  bindJobModel(jobId,fingerprint){const saved=this.db.prepare("SELECT fingerprint FROM job_model_configs WHERE job_id=?").get(jobId);if(saved&&saved.fingerprint!==fingerprint)throw new Error("模型或上游地址已改变，不能自动恢复旧任务；请恢复原配置后继续");this.db.prepare("INSERT OR IGNORE INTO job_model_configs(job_id,fingerprint) VALUES(?,?)").run(jobId,fingerprint);}
  latestGenerationJob(projectId,userId){const row=this.db.prepare("SELECT id FROM generation_jobs WHERE project_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(projectId,userId);return row?this.generationJob(row.id,userId):null;}

  chapterDetails(projectId) {
    return this.db.prepare("SELECT r.chapter,r.title,r.summary,r.state_changes_json,m.model,m.input_tokens,m.output_tokens,m.cached_tokens,m.cost_usd,m.latency_ms,m.retries,m.request_id FROM chapter_records r LEFT JOIN chapter_metrics m ON m.project_id=r.project_id AND m.chapter=r.chapter WHERE r.project_id=? ORDER BY r.chapter").all(projectId)
      .map(row=>({ ...row,stateChanges:JSON.parse(row.state_changes_json),state_changes_json:undefined }));
  }

  memoryStats(projectId) {
    const count=table=>this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`).get(projectId).n;
    return {projectId,characters:count("story_characters"),events:count("story_events"),chapters:count("chapter_records"),openClues:this.db.prepare("SELECT COUNT(*) n FROM story_clues WHERE project_id=? AND status='open'").get(projectId).n};
  }

  knowledgeBase(projectId) {
    const parse=(rows,key)=>rows.map(row=>({ ...row,[key]:JSON.parse(row[key]) }));
    return {
      identities:this.identities(projectId),
      observations:this.db.prepare("SELECT chapter,extractor_version,payload_json FROM story_observations WHERE project_id=? ORDER BY chapter").all(projectId).map(r=>({chapter:r.chapter,version:r.extractor_version,evidence:JSON.parse(r.payload_json)})),
      characters:parse(this.db.prepare("SELECT name,latest_state_json,last_chapter FROM story_characters WHERE project_id=? ORDER BY name").all(projectId),"latest_state_json"),
      items:this.db.prepare("SELECT name,owner,status,last_chapter FROM story_items WHERE project_id=? ORDER BY name").all(projectId),
      clues:this.db.prepare("SELECT name,status,introduced_chapter,resolved_chapter,evidence_json FROM story_clues WHERE project_id=? ORDER BY introduced_chapter").all(projectId).map(row=>({ ...row,evidence:JSON.parse(row.evidence_json),evidence_json:undefined })),
      knowledge:this.db.prepare("SELECT character,fact,status,chapter,paragraph,evidence FROM story_knowledge WHERE project_id=? ORDER BY chapter,paragraph").all(projectId),
      chapters:this.chapterDetails(projectId),
    };
  }

  findContradictions(projectId,{ scope="book",startChapter=1,endChapter=100000 }={}) {
    const evidence=this.db.prepare("SELECT chapter,paragraph,category,subject,predicate,object,evidence FROM story_evidence WHERE project_id=? AND chapter<=? ORDER BY chapter,paragraph").all(projectId,endChapter);
    const inScope=item=>item.chapter>=startChapter&&item.chapter<=endChapter;
    const findings=[];
    const add=(category,severity,description,items)=>findings.push({ id:randomUUID(),category,severity,description,evidence:items.map(item=>({chapter:item.chapter,paragraph:item.paragraph,quote:item.evidence})) });
    for (const death of evidence.filter(item=>item.category==="character"&&item.predicate==="生命状态"&&item.object==="死亡")) {
      const later=evidence.find(item=>item.subject===death.subject&&(item.chapter>death.chapter||(item.chapter===death.chapter&&item.paragraph>death.paragraph))&&item.category==="character"&&item.predicate==="所在地"&&inScope(item));
      if (later&&(inScope(death)||inScope(later))) add("character","error",`${death.subject}死亡后仍以正常状态出现在新地点`,[death,later]);
    }
    for (const item of evidence.filter(value=>value.category==="item")) {
      const conflict=evidence.find(value=>value!==item&&value.category==="item"&&value.subject===item.subject&&value.object!==item.object&&value.chapter===item.chapter&&!/交给|递给|转交给|送给|还给|丢失|丢掉|扔掉|销毁/.test(value.evidence+item.evidence));
      if (conflict&&inScope(item)&&!findings.some(value=>value.category==="item"&&value.description.includes(item.subject))) add("item","warning",`${item.subject}在同一章存在不同持有人`,[item,conflict]);
    }
    for (const unknown of evidence.filter(item=>item.category==="knowledge"&&item.predicate==="未知")) {
      const known=evidence.find(item=>item.category==="knowledge"&&item.subject===unknown.subject&&item.predicate==="已知"&&item.chapter===unknown.chapter&&Math.abs(item.paragraph-unknown.paragraph)<=2);
      if (known&&!known.evidence.includes("得知")&&(inScope(unknown)||inScope(known))) add("knowledge","warning",`${unknown.subject}在缺少获知过程时同时表现为已知和未知`,[unknown,known]);
    }
    this.db.prepare("DELETE FROM contradiction_findings WHERE project_id=? AND scope=? AND start_chapter=? AND end_chapter=?").run(projectId,scope,startChapter,endChapter);
    const insert=this.db.prepare("INSERT INTO contradiction_findings(id,project_id,scope,start_chapter,end_chapter,category,severity,description,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const finding of findings) insert.run(finding.id,projectId,scope,startChapter,endChapter,finding.category,finding.severity,finding.description,JSON.stringify(finding.evidence),nowIso());
    return findings;
  }

  runReview(projectId,{ scope,chapter,volumeStart,volumeEnd }) {
    const available=this.db.prepare("SELECT chapter FROM chapter_records WHERE project_id=? ORDER BY chapter").all(projectId).map(row=>row.chapter);
    const startChapter=scope==="chapter" ? chapter : scope==="volume" ? volumeStart : 1;
    const endChapter=scope==="chapter" ? chapter : scope==="volume" ? volumeEnd : available.at(-1)||0;
    if(!["chapter","volume","book"].includes(scope)||!Number.isInteger(startChapter)||!Number.isInteger(endChapter)||startChapter<1||endChapter<startChapter||endChapter>10000){
      throw Object.assign(new Error("审查范围无效或尚无正文章节"),{code:"REVIEW_RANGE_INVALID",status:400});
    }
    const coveredChapters=available.filter(value=>value>=startChapter&&value<=endChapter),covered=new Set(coveredChapters);
    const missingChapters=Array.from({length:endChapter-startChapter+1},(_,index)=>startChapter+index).filter(value=>!covered.has(value));
    const coverage={requestedChapters:endChapter-startChapter+1,coveredChapters,missingChapters};
    if(missingChapters.length){
      throw Object.assign(new Error(`审查未执行：第 ${missingChapters.slice(0,20).join("、")}${missingChapters.length>20?" 等":""} 章尚未生成或缺失；实际覆盖 ${coveredChapters.length}/${coverage.requestedChapters} 章`),{code:"REVIEW_RANGE_MISSING",status:409,coverage});
    }
    const findings=this.findContradictions(projectId,{ scope,startChapter,endChapter });
    const summary=`已覆盖第 ${startChapter}-${endChapter} 章（${coveredChapters.length}/${coverage.requestedChapters}）；`+(findings.length ? `发现 ${findings.length} 项带段落证据的问题。` : "未发现当前规则可识别的矛盾；不代表语义或文学质量通过。");
    const id=randomUUID();
    this.db.prepare("INSERT INTO review_runs(id,project_id,scope,start_chapter,end_chapter,findings_json,summary,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id,projectId,scope,startChapter,endChapter,JSON.stringify(findings),summary,nowIso());
    return { id,scope,startChapter,endChapter,coverage,findings,summary };
  }

  previewContradictions(projectId,chapter,text) {
    const candidate=chapterExtraction(chapter,text).records;
    const prior=this.db.prepare("SELECT chapter,paragraph,category,subject,predicate,object,evidence FROM story_evidence WHERE project_id=? AND chapter<? ORDER BY chapter,paragraph").all(projectId,chapter);
    const findings=[];
    for (const location of candidate.filter(item=>item.category==="character"&&item.predicate==="所在地")) {
      const death=[...prior].reverse().find(item=>item.category==="character"&&item.subject===location.subject&&item.predicate==="生命状态"&&item.object==="死亡");
      if (death) findings.push({category:"character",severity:"error",description:`${location.subject}此前已死亡，本章却在新地点正常行动`,evidence:[{chapter:death.chapter,paragraph:death.paragraph,quote:death.evidence},{chapter,paragraph:location.paragraph,quote:location.evidence}]});
    }
    for (const known of candidate.filter(item=>item.category==="knowledge"&&item.predicate==="已知")) {
      const unknown=[...prior].reverse().find(item=>item.category==="knowledge"&&item.subject===known.subject&&item.predicate==="未知"&&aliasSignature(item.object)===aliasSignature(known.object));
      if (unknown&&!known.evidence.includes("得知")) findings.push({category:"knowledge",severity:"warning",description:`${known.subject}使用了此前标记为未知且未展示获知过程的信息`,evidence:[{chapter:unknown.chapter,paragraph:unknown.paragraph,quote:unknown.evidence},{chapter,paragraph:known.paragraph,quote:known.evidence}]});
    }
    return findings;
  }

  memoryContext(projectId, query, limit=10) {
    const queryVector=vectorize(query);
    const chunks=rankMemory(this.db.prepare("SELECT chapter,chunk_index,text,vector_json FROM story_chunks WHERE project_id=?").all(projectId)
      .map(row=>({chapter:row.chapter,chunk_index:row.chunk_index,text:row.text,score:cosine(queryVector,JSON.parse(row.vector_json))})),query,{aliases:this.identities(projectId),limit});
    const facts=this.db.prepare("SELECT chapter,kind,subject,predicate,object,evidence FROM story_facts WHERE project_id=? ORDER BY chapter DESC LIMIT 120").all(projectId);
    const navigation=this.db.prepare("SELECT chapter,title,summary FROM chapter_records WHERE project_id=? ORDER BY chapter DESC LIMIT 60").all(projectId).reverse();
    const timeline=this.db.prepare("SELECT t.chapter,t.sequence,t.time_label,t.location,e.actor,e.action,e.target,e.evidence FROM story_timeline t JOIN story_events e ON e.id=t.event_id WHERE t.project_id=? ORDER BY t.chapter DESC,t.sequence DESC LIMIT 120").all(projectId).reverse();
    const characters=this.db.prepare("SELECT name,latest_state_json,last_chapter FROM story_characters WHERE project_id=? ORDER BY last_chapter DESC LIMIT 80").all(projectId);
    const items=this.db.prepare("SELECT name,owner,status,last_chapter FROM story_items WHERE project_id=? ORDER BY last_chapter DESC LIMIT 80").all(projectId);
    const clues=this.db.prepare("SELECT name,status,introduced_chapter,resolved_chapter FROM story_clues WHERE project_id=? ORDER BY COALESCE(resolved_chapter,introduced_chapter) DESC LIMIT 80").all(projectId);
    const knowledge=this.db.prepare("SELECT character,fact,status,chapter,paragraph,evidence FROM story_knowledge WHERE project_id=? ORDER BY chapter DESC,paragraph DESC LIMIT 80").all(projectId);
    if (!chunks.length && !facts.length) return "";
    const section=(title,lines,budget)=>`## ${title}\n${(lines.join("\n") || "无").slice(0,budget)}`;
    return [
      section("全章导航（最近 60 章定稿）",navigation.map(item=>`- 第${item.chapter}章 ${item.title}：${item.summary}`),2000),
      section("当前人物状态",characters.map(item=>`- ${item.name}（截至第${item.last_chapter}章）：${JSON.stringify(JSON.parse(item.latest_state_json))}`),1500),
      section("物品与伏笔",items.map(item=>`- 物品 ${item.name}：${item.owner}${item.status}（第${item.last_chapter}章）`).concat(clues.map(item=>`- 伏笔 ${item.name}：${item.status}（埋设第${item.introduced_chapter}章${item.resolved_chapter?`，回收第${item.resolved_chapter}章`:""}）`)),1500),
      section("人物知识边界",knowledge.map(item=>`- 第${item.chapter}章第${item.paragraph}段 ${item.character}${item.status}${item.fact}（${item.evidence}）`),2000),
      section("实体、事件与时间线",timeline.map(item=>`- ${item.time_label}#${item.sequence}${item.location ? ` @${item.location}` : ""}：${item.actor}${item.action}${item.target}（${item.evidence}）`),2500),
      section("结构化故事事实",facts.map(item=>`- 第${item.chapter}章 [${item.kind}] ${item.subject}${item.predicate}${item.object}（${item.evidence}）`),2500),
      section("向量检索相关正文（仅定稿）",chunks.map(item=>`### 第${item.chapter}章（相关度 ${item.score.toFixed(3)}）\n${item.text.slice(0,1800)}`),6000),
    ].join("\n\n");
  }

  saveVersion(project) {
    const previousRevision=this.db.prepare("SELECT revision FROM project_versions WHERE project_id=? ORDER BY revision DESC LIMIT 1").get(project.projectId)?.revision;
    const old=previousRevision == null ? null : this.versionSnapshot(project.projectId,previousRevision);
    const changed=Object.keys(project.content || {}).filter(key=>old?.content?.[key]!==project.content?.[key]);
    const putBlob=this.db.prepare("INSERT OR IGNORE INTO content_blobs(content_hash,content_type,text,bytes,created_at) VALUES(?,?,?,?,?)");
    const contentRefs={};
    for (const [key,value] of Object.entries(project.content || {})) {
      if (key==="draft") {
        const layout=draftSegments(value);
        contentRefs.draft={format:"segments-v1",prefix:layout.prefix,segments:layout.segments.map(item=>{const contentHash=hash(item.text);putBlob.run(contentHash,"chapter",item.text,Buffer.byteLength(item.text),nowIso());return{chapter:item.chapter,hash:contentHash}})};
      } else {
        const text=String(value || ""),contentHash=hash(text);putBlob.run(contentHash,`module:${key}`,text,Buffer.byteLength(text),nowIso());contentRefs[key]=contentHash;
      }
    }
    const metadata={...project,content:undefined};
    const manifest={format:"refs-v2",metadata,contentRefs};
    const compact=JSON.stringify({__format:"refs-v2",revision:project.revision,manifestTable:"project_version_manifests"});
    this.db.prepare("INSERT OR REPLACE INTO project_version_manifests(project_id,revision,manifest_json,created_at) VALUES(?,?,?,?)").run(project.projectId,project.revision,JSON.stringify(manifest),project.updatedAt || nowIso());
    this.db.prepare("INSERT OR IGNORE INTO project_versions(project_id,revision,snapshot_json,changed_modules_json,created_at) VALUES(?,?,?,?,?)").run(project.projectId,project.revision,compact,JSON.stringify(changed),project.updatedAt || nowIso());
    return { revision:project.revision,changedModules:changed };
  }

  listVersions(projectId) {
    return this.db.prepare("SELECT revision,changed_modules_json,created_at,LENGTH(snapshot_json) bytes FROM project_versions WHERE project_id=? ORDER BY revision DESC").all(projectId).map(row=>({ revision:row.revision,changedModules:JSON.parse(row.changed_modules_json),createdAt:row.created_at,bytes:row.bytes }));
  }

  versionSnapshot(projectId,revision) {
    const manifestRow=this.db.prepare("SELECT manifest_json FROM project_version_manifests WHERE project_id=? AND revision=?").get(projectId,revision);
    if (manifestRow) {
      const manifest=JSON.parse(manifestRow.manifest_json),content={};
      for (const [key,reference] of Object.entries(manifest.contentRefs || {})) {
        if (key==="draft"&&Array.isArray(reference)) content.draft=reference.map(item=>this.db.prepare("SELECT text FROM content_blobs WHERE content_hash=?").get(item.hash)?.text || "").filter(Boolean).join("\n\n---\n\n");
        else if (key==="draft"&&reference?.format==="segments-v1") content.draft=String(reference.prefix||"")+reference.segments.map(item=>this.db.prepare("SELECT text FROM content_blobs WHERE content_hash=?").get(item.hash)?.text || "").join("");
        else content[key]=this.db.prepare("SELECT text FROM content_blobs WHERE content_hash=?").get(reference)?.text || "";
      }
      return { ...manifest.metadata,content };
    }
    const row=this.db.prepare("SELECT snapshot_json FROM project_versions WHERE project_id=? AND revision=?").get(projectId,revision);
    if (!row) return null;
    const parsed=JSON.parse(row.snapshot_json);
    return parsed?.__format==="refs-v2" ? null : parsed;
  }

  compareVersions(projectId,leftRevision,rightRevision,{module="draft",chapter=1}={}) {
    const left=this.versionSnapshot(projectId,leftRevision),right=this.versionSnapshot(projectId,rightRevision);
    if (!left||!right) return null;
    const keys=new Set([...Object.keys(left.content||{}),...Object.keys(right.content||{})]);
    const a=module==="draft"?chaptersFromDraft(left.content?.draft):null,b=module==="draft"?chaptersFromDraft(right.content?.draft):null;
    const leftText=a?a.find(c=>c.chapter===chapter)?.text||"":left.content?.[module]||"",rightText=b?b.find(c=>c.chapter===chapter)?.text||"":right.content?.[module]||"";
    const diff=leftText.length>40000||rightText.length>40000?{available:false,reason:"该模块超过逐段比较上限，请查看原文",rows:[]}:paragraphDiff(leftText,rightText);
    return { leftRevision,rightRevision,module,chapter,totalChapters:Math.max(a?.length||0,b?.length||0),diff,fieldsChanged:JSON.stringify(left.fields)!==JSON.stringify(right.fields),modules:[...keys].map(key=>({ module:key,changed:left.content?.[key]!==right.content?.[key],leftCharacters:String(left.content?.[key]||"").length,rightCharacters:String(right.content?.[key]||"").length })).filter(item=>item.changed) };
  }

  addReaderEvaluation(value) {
    this.db.prepare("INSERT INTO reader_evaluations(id,project_id,chapter,reviewer_id,continue_reading,interest_character,lost_interest,confusion,prediction,machine_like,time_commitment_minutes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,chapter,reviewer_id) DO UPDATE SET continue_reading=excluded.continue_reading,interest_character=excluded.interest_character,lost_interest=excluded.lost_interest,confusion=excluded.confusion,prediction=excluded.prediction,machine_like=excluded.machine_like,time_commitment_minutes=excluded.time_commitment_minutes,created_at=excluded.created_at")
      .run(randomUUID(),value.projectId,value.chapter,value.reviewerId,value.continueReading?1:0,clean(value.interestCharacter),clean(value.lostInterest),clean(value.confusion),clean(value.prediction),value.machineLike?1:0,value.timeCommitmentMinutes,nowIso());
    return this.readerMetrics(value.projectId);
  }

  createBlindSession(projectId,chapter) {
    const code=randomUUID();const createdAt=nowIso();const expiresAt=new Date(Date.now()+7*86400000).toISOString();
    this.db.prepare("INSERT INTO blind_review_sessions(code,project_id,chapter,created_at,expires_at) VALUES(?,?,?,?,?)").run(code,projectId,chapter,createdAt,expiresAt);
    return { code,chapter,expiresAt };
  }

  blindSample(code) {
    const session=this.db.prepare("SELECT project_id,chapter,expires_at,used_at FROM blind_review_sessions WHERE code=?").get(code);
    if (!session||session.used_at||session.expires_at<nowIso()) return null;
    const record=this.db.prepare("SELECT summary,paragraphs_json FROM chapter_records WHERE project_id=? AND chapter=?").get(session.project_id,session.chapter);
    if (!record) return null;
    return { code,chapter:session.chapter,excerpt:JSON.parse(record.paragraphs_json).map(item=>item.text).join("\n\n"),expiresAt:session.expires_at };
  }

  submitBlindEvaluation(code,value) {
    const sample=this.blindSample(code);if (!sample) return null;
    const session=this.db.prepare("SELECT project_id,chapter FROM blind_review_sessions WHERE code=?").get(code);
    const metrics=this.addReaderEvaluation({ ...value,projectId:session.project_id,chapter:session.chapter,reviewerId:`blind:${code}` });
    this.db.prepare("UPDATE blind_review_sessions SET used_at=? WHERE code=?").run(nowIso(),code);
    return metrics;
  }

  readerMetrics(projectId) {
    const summary=this.db.prepare("SELECT COUNT(*) responses,COALESCE(AVG(continue_reading)*100,0) continue_rate,COALESCE(AVG(machine_like)*100,0) machine_like_rate,COALESCE(AVG(time_commitment_minutes),0) avg_minutes FROM reader_evaluations WHERE project_id=?").get(projectId);
    return { responses:Number(summary.responses),continueReadingRate:Math.round(Number(summary.continue_rate)),machineLikeRate:Math.round(Number(summary.machine_like_rate)),averageTimeCommitmentMinutes:Math.round(Number(summary.avg_minutes)*10)/10 };
  }

  addProjectDataset({ project, userId, license, qualityScore=0, reviewNotes="" }) {
    const content=project.content || {};
    const fields=JSON.stringify(project.fields || {});
    const pairs=[
      ["brief",fields,content.brief],["bible",content.brief,content.bible],["outline",content.bible,content.outline],
      ["scene",content.outline,content.scene],["review",content.draft,content.review],
    ];
    for (const pair of project.chapterProgress?.revisionPairs || []) if (pair?.approved===true) pairs.push(["revision",`${pair.original || ""}\n\n编辑问题：\n${JSON.stringify(pair.issues || [])}`,pair.revised]);
    for (const chapter of chaptersFromDraft(content.draft)) pairs.push(["draft",`${content.bible || ""}\n${content.scene || ""}\n${this.memoryContext(project.projectId,chapter.text.slice(0,500),6)}\n生成第${chapter.chapter}章`,chapter.text]);
    const insert=this.db.prepare("INSERT OR IGNORE INTO dataset_samples(id,project_id,user_id,task,input_text,output_text,license,split,content_hash,consent_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
    let added=0;
    for (const [task,input,output] of pairs) {
      if (clean(input).length<10 || clean(output).length<20) continue;
      const sampleHash=hash(`${task}\n${input}\n${output}`);
      const sampleId=randomUUID();
      const sourceId=project.fields?.sourceStoryId || project.projectId;
      const result=insert.run(sampleId,project.projectId,userId,task,String(input),String(output),license,splitForProject(sourceId),sampleHash,nowIso());
      const storedId=result.changes ? sampleId : this.db.prepare("SELECT id FROM dataset_samples WHERE content_hash=?").get(sampleHash).id;
      this.db.prepare("INSERT OR REPLACE INTO dataset_quality(sample_id,quality_score,review_notes,approved,reviewed_at) VALUES(?,?,?,?,?)").run(storedId,qualityScore,clean(reviewNotes).slice(0,1000),qualityScore>=80?1:0,nowIso());
      added+=Number(result.changes || 0);
    }
    return { added, total:this.db.prepare("SELECT COUNT(*) count FROM dataset_samples").get().count, split:splitForProject(project.fields?.sourceStoryId || project.projectId) };
  }

  datasetRows(split,{ approvedOnly=true }={}) { return this.db.prepare(`SELECT s.task,s.input_text,s.output_text,s.license,s.project_id,q.quality_score FROM dataset_samples s JOIN dataset_quality q ON q.sample_id=s.id WHERE s.split=? ${approvedOnly ? "AND q.approved=1" : ""} ORDER BY s.project_id,s.task`).all(split); }
  datasetReadiness() {
    const total=this.db.prepare("SELECT COUNT(*) count FROM dataset_samples").get().count;
    const approved=this.db.prepare("SELECT COUNT(*) count FROM dataset_quality WHERE approved=1").get().count;
    const tasks=this.db.prepare("SELECT s.task,COUNT(*) count FROM dataset_samples s JOIN dataset_quality q ON q.sample_id=s.id WHERE q.approved=1 GROUP BY s.task ORDER BY s.task").all();
    const groups={ planning:0,draft:0,review:0,revision:0 };
    for(const item of tasks) { const group=["brief","bible","outline","scene"].includes(item.task)?"planning":item.task; if(group in groups)groups[group]+=item.count; }
    const balanced=Object.values(groups).every(value=>value>=25);
    return { total,approved,tasks,groups,thresholds:{ perTaskGroup:25,ragEvaluation:100,fineTuneEvaluation:500,specializedModelEvaluation:5000 },recommendation:approved<100||!balanced?"先优化提示词并补齐规划、正文、审校、修订四类授权评测集":approved<500?"可开始在固定测试集上比较提示词与 RAG":"可在固定测试集上加入微调对照实验",fineTuneReady:approved>=500&&balanced,specializedModelReady:approved>=5000&&balanced };
  }
  createTrainingRun({ type, provider, model, datasetPath, status="prepared", metrics={} }) {
    const id=randomUUID(), now=nowIso();
    this.db.prepare("INSERT INTO training_runs(id,type,provider,model,status,dataset_path,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id,type,provider,model,status,datasetPath,JSON.stringify(metrics),now,now);
    return { id,type,provider,model,status,datasetPath,metrics };
  }

  recordCall(call) {
    this.db.prepare("INSERT INTO model_calls(id,user_id,project_id,mode,model,status,latency_ms,input_tokens,output_tokens,retries,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(),call.userId,call.projectId || null,call.mode,call.model,call.status,call.latencyMs,call.inputTokens||0,call.outputTokens||0,call.retries||0,call.requestId||null,nowIso());
  }

  recordCallAttempt(attempt) {
    this.db.prepare("INSERT INTO model_call_attempts(id,call_group_id,user_id,project_id,mode,attempt,model,status,latency_ms,input_tokens,output_tokens,usage_known,request_id,output_cap,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(),attempt.callGroupId,attempt.userId,attempt.projectId || null,attempt.mode,attempt.attempt,attempt.model || "unknown",attempt.status,attempt.latencyMs||0,attempt.inputTokens||0,attempt.outputTokens||0,attempt.usageKnown?1:0,attempt.requestId||null,attempt.outputCap||0,nowIso());
  }

  callAttempts(callGroupId) {
    return this.db.prepare("SELECT attempt,model,status,latency_ms,input_tokens,output_tokens,usage_known,request_id,output_cap,created_at FROM model_call_attempts WHERE call_group_id=? ORDER BY attempt").all(callGroupId).map(row=>({...row,usageKnown:Boolean(row.usage_known)}));
  }

  createGenerationJob({ projectId,userId,requestedChapters,startChapter,expectedRevision }) {
    const active=this.generationJobForProject(projectId,userId);
    if (active) return active;
    const id=randomUUID(),createdAt=nowIso();
    this.db.prepare("INSERT INTO generation_jobs(id,project_id,user_id,status,requested_chapters,completed_chapters,start_chapter,next_chapter,expected_revision,created_at,updated_at) VALUES(?,?,?,'running',?,0,?,?,?,?,?)")
      .run(id,projectId,userId,requestedChapters,startChapter,startChapter,expectedRevision,createdAt,createdAt);
    return this.generationJob(id,userId);
  }

  generationJob(id,userId) {
    const row=this.db.prepare("SELECT id,project_id,user_id,status,requested_chapters,completed_chapters,start_chapter,next_chapter,expected_revision,last_error,active_response_id,created_at,updated_at FROM generation_jobs WHERE id=? AND user_id=?").get(id,userId);
    return row ? { id:row.id,projectId:row.project_id,status:row.status,requestedChapters:row.requested_chapters,completedChapters:row.completed_chapters,startChapter:row.start_chapter,nextChapter:row.next_chapter,expectedRevision:row.expected_revision,lastError:row.last_error,activeResponseId:row.active_response_id,createdAt:row.created_at,updatedAt:row.updated_at } : null;
  }

  generationJobForProject(projectId,userId) {
    const row=this.db.prepare("SELECT id FROM generation_jobs WHERE project_id=? AND user_id=? AND status IN ('running','paused','failed') ORDER BY updated_at DESC LIMIT 1").get(projectId,userId);
    return row ? this.generationJob(row.id,userId) : null;
  }

  updateGenerationJob({ id,userId,status,projectCompleted,expectedRevision,lastError="" }) {
    const current=this.generationJob(id,userId);
    if (!current) return null;
    const completed=Math.max(0,Math.min(current.requestedChapters,projectCompleted-current.startChapter+1));
    const terminal=completed>=current.requestedChapters;
    const nextStatus=terminal ? "completed" : status;
    this.db.prepare("UPDATE generation_jobs SET status=?,completed_chapters=?,next_chapter=?,expected_revision=?,last_error=?,updated_at=? WHERE id=? AND user_id=?")
      .run(nextStatus,completed,projectCompleted+1,expectedRevision,clean(lastError).slice(0,500)||null,nowIso(),id,userId);
    return this.generationJob(id,userId);
  }

  recordQuality({ projectId, model, metric, value }) {
    this.db.prepare("INSERT INTO quality_observations(id,project_id,model,metric,value,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),projectId,model,metric,value,nowIso());
    const values=this.db.prepare("SELECT value FROM quality_observations WHERE metric=? AND model=? ORDER BY created_at").all(metric,model).map(row=>row.value);
    if (values.length>=10) {
      const baseline=values.slice(0,5).reduce((sum,item)=>sum+item,0)/5;
      const recent=values.slice(-5).reduce((sum,item)=>sum+item,0)/5;
      if (recent<baseline-15) this.addAlert("warning","MODEL_DRIFT",`${metric}近期均值下降 ${Math.round(baseline-recent)} 分`,{model,baseline,recent});
    }
  }

  addAlert(severity,code,message,details={}) {
    const existing=this.db.prepare("SELECT id FROM alerts WHERE code=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1").get(code);
    if (!existing) this.db.prepare("INSERT INTO alerts(id,severity,code,message,details_json,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),severity,code,message,JSON.stringify(details),nowIso());
  }

  dailyTokens(userId,now=new Date()) {
    const start=new Date(now);start.setHours(0,0,0,0);
    return this.db.prepare("SELECT COALESCE(SUM(input_tokens+output_tokens),0) total FROM model_calls WHERE user_id=? AND created_at>=?").get(userId,start.toISOString()).total;
  }

  status() {
    const calls=this.db.prepare("SELECT COUNT(*) calls,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(AVG(latency_ms),0) avg_latency_ms,SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) failures FROM model_calls").get();
    return {
      datasetSamples:this.db.prepare("SELECT COUNT(*) count FROM dataset_samples").get().count,
      trainingRuns:this.db.prepare("SELECT COUNT(*) count FROM training_runs").get().count,
      vectorChunks:this.db.prepare("SELECT COUNT(*) count FROM story_chunks").get().count,
      storyFacts:this.db.prepare("SELECT COUNT(*) count FROM story_facts").get().count,
      storyEntities:this.db.prepare("SELECT COUNT(*) count FROM story_entities").get().count,
      storyEvents:this.db.prepare("SELECT COUNT(*) count FROM story_events").get().count,
      timelineEntries:this.db.prepare("SELECT COUNT(*) count FROM story_timeline").get().count,
      chapterRecords:this.db.prepare("SELECT COUNT(*) count FROM chapter_records").get().count,
      structuredCharacters:this.db.prepare("SELECT COUNT(*) count FROM story_characters").get().count,
      structuredItems:this.db.prepare("SELECT COUNT(*) count FROM story_items").get().count,
      structuredClues:this.db.prepare("SELECT COUNT(*) count FROM story_clues").get().count,
      knowledgeBoundaries:this.db.prepare("SELECT COUNT(*) count FROM story_knowledge").get().count,
      contradictions:this.db.prepare("SELECT COUNT(*) count FROM contradiction_findings WHERE status='open'").get().count,
      readerEvaluations:this.db.prepare("SELECT COUNT(*) count FROM reader_evaluations").get().count,
      projects:this.db.prepare("SELECT COUNT(*) count FROM project_owners").get().count,
      alerts:this.db.prepare("SELECT COUNT(*) count FROM alerts WHERE resolved_at IS NULL").get().count,
      resumableGenerationJobs:this.db.prepare("SELECT COUNT(*) count FROM generation_jobs WHERE status IN ('running','paused','failed')").get().count,
      calls:Number(calls.calls||0), failures:Number(calls.failures||0), inputTokens:Number(calls.input_tokens||0), outputTokens:Number(calls.output_tokens||0), averageLatencyMs:Math.round(Number(calls.avg_latency_ms||0)),
    };
  }

  close() { this.db.close(); }
}

export const platformInternals={ vectorize, cosine, chaptersFromDraft, draftSegments, splitForProject, localFacts, chapterExtraction };
