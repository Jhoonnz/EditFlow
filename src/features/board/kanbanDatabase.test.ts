import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../workspace/types';

// Real Postgres execution in memory. Only Supabase's auth/storage provider
// schemas are stubbed; app migrations, permissions and triggers run unchanged.
const owner = '10000000-0000-4000-8000-000000000001';
const editor = '10000000-0000-4000-8000-000000000002';
const outsider = '10000000-0000-4000-8000-000000000003';
let db: PGlite;
let workspace: string;
let board: string;
let first: string;
let final: string;
let middle: string;
let client: string;

async function signIn(id: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function task(id: string) {
  return (await db.query<{ row: Task & { activity_at: string } }>('select to_jsonb(t) as row from public.tasks t where id=$1', [id])).rows[0].row;
}
async function createTask(title = 'Vídeo') {
  const result = await db.query<{ id: string }>(`insert into public.tasks(workspace_id,board_id,column_id,client_id,assignee_id,title,position,created_by)
    values($1,$2,$3,$4,$5,$6,1000,$7) returning id`, [workspace, board, first, client, editor, title, owner]);
  return task(result.rows[0].id);
}
async function move(row: Task, column: string, before: string | null = null) {
  await db.query('select public.move_task_safely($1,$2,$3,$4)', [row.id, column, before, row.updated_at]);
  return task(row.id);
}
async function count(table: string) {
  return Number((await db.query<{ count: number }>(`select count(*) from public.${table} where workspace_id=$1`, [workspace])).rows[0].count);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    grant usage on schema auth to authenticated;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
    create publication supabase_realtime;
  `);
  const directory = resolve('supabase/migrations');
  for (const name of readdirSync(directory).filter((name) => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 31 && !name.startsWith('030_')).sort()) {
    // gen_random_uuid is built into PostgreSQL; optional pgcrypto binaries are
    // not shipped by this in-memory test engine. No application SQL is removed.
    const sql = readFileSync(resolve(directory, name), 'utf8').replace('create extension if not exists pgcrypto;', '');
    try { await db.exec(sql); } catch (error) { throw new Error(`Migration ${name}: ${String(error)}`); }
  }
  await db.query(`insert into auth.users(id,email,raw_user_meta_data) values($1,'owner@test.invalid','{"full_name":"Dono"}'),($2,'editor@test.invalid','{"full_name":"Editor"}'),($3,'outside@test.invalid','{}')`, [owner, editor, outsider]);
}, 60_000);

beforeEach(async () => {
  await signIn(owner);
  workspace = (await db.query<{ id: string }>("select public.create_workspace('Teste Kanban') as id")).rows[0].id;
  board = (await db.query<{ id: string }>('select id from public.boards where workspace_id=$1', [workspace])).rows[0].id;
  const columns = (await db.query<{ id: string }>('select id from public.columns where board_id=$1 order by position,id', [board])).rows;
  first = columns[0].id; middle = columns[1].id; final = columns.at(-1)!.id;
  // Membership is provisioned by the invitation service in production.
  await db.exec('reset role');
  await db.query("insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'editor')", [workspace, editor]);
  await signIn(owner);
  client = (await db.query<{ id: string }>("insert into public.clients(workspace_id,name) values($1,'Cliente') returning id", [workspace])).rows[0].id;
  await db.query("insert into public.client_billing_settings(workspace_id,client_id,currency,pricing_model,amount_usd) values($1,$2,'BRL','per_video',100)", [workspace, client]);
  await db.query("select public.update_editor_compensation($1,$2,'BRL',40,'[]')", [workspace, editor]);
});
afterAll(async () => { await db?.close(); });

describe('Kanban database integration', () => {
  it('primeiro envio preserva prazo e pontualidade durante alterações e reenvios, sem gerar ganhos', async () => {
    let row = await createTask();
    await db.query("update public.tasks set due_at=((now() at time zone 'America/Sao_Paulo')::date + time '12:00') at time zone 'America/Sao_Paulo' where id=$1", [row.id]);
    await db.query('update public.columns set automation_client_review=true where id=$1', [middle]);
    row = await move(await task(row.id), middle);
    const firstSent = row.first_sent_at;
    const originalDue = row.due_at;
    expect(firstSent).not.toBeNull();
    expect(row.first_sent_due_at).toBe(originalDue);
    expect(row.first_sent_late).toBe(false);
    expect(row.completed_at).toBeNull();
    expect(await count('earnings')).toBe(0);
    expect(await count('editor_cost_entries')).toBe(0);
    row = await move(row, first);
    expect(row.due_at).toBe(originalDue);
    expect(row.first_sent_at).toBe(firstSent);
    await db.query("update public.tasks set due_at=now()-interval '5 days' where id=$1", [row.id]);
    row = await move(await task(row.id), middle);
    expect(row.first_sent_at).toBe(firstSent);
    expect(row.first_sent_due_at).toBe(originalDue);
    expect(row.first_sent_late).toBe(false);
    const history = (await db.query<{ details: { first_submission: boolean } }>("select details from public.task_activities where task_id=$1 and details->>'client_submission'='true' order by created_at", [row.id])).rows;
    expect(history.map((entry) => entry.details.first_submission)).toEqual([true, false]);
    row = await move(row, final);
    expect(row.first_sent_at).toBe(firstSent);
    expect(await count('earnings')).toBe(1);
    expect(await count('editor_cost_entries')).toBe(1);
    const copied = (await db.query<{ id: string }>('select id from public.duplicate_task($1,false)', [row.id])).rows[0].id;
    expect((await task(copied)).first_sent_at).toBeNull();
  });

  it('envio atrasado permanece atrasado e envio sem prazo não inventa pontualidade', async () => {
    const late = await createTask('Atrasado');
    const undated = await createTask('Sem prazo');
    await db.query("update public.tasks set due_at=now()-interval '3 days' where id=$1", [late.id]);
    await db.query('update public.columns set automation_client_review=true where id=$1', [middle]);
    let sent = await move(await task(late.id), middle);
    expect(sent.first_sent_late).toBe(true);
    sent = await move(sent, first);
    expect(sent.first_sent_late).toBe(true);
    const noDeadline = await move(undated, middle);
    expect(noDeadline.first_sent_at).not.toBeNull();
    expect(noDeadline.first_sent_late).toBeNull();
    expect(noDeadline.first_sent_due_at).toBeNull();
  });

  it('não inventa envio retroativo nem registra reordenação como envio', async () => {
    let row = await move(await createTask(), middle);
    expect(row.first_sent_at).toBeNull();
    await db.query('update public.columns set automation_client_review=true where id=$1', [middle]);
    row = await move(row, middle);
    expect(row.first_sent_at).toBeNull();
    row = await move(row, first);
    row = await move(row, middle);
    const stamp = row.first_sent_at;
    await db.query("update public.columns set name='Cliente avaliando',automation_client_review=false where id=$1", [middle]);
    row = await move(row, first);
    expect(row.first_sent_at).toBe(stamp);
  });

  it('protege configuração, snapshot e separação da conclusão; editor pode enviar', async () => {
    const row = await createTask();
    await expect(db.query('update public.tasks set first_sent_at=now() where id=$1', [row.id])).rejects.toThrow(/primeiro envio/);
    await expect(db.query('update public.columns set automation_client_review=true where id=$1', [final])).rejects.toThrow(/columns_review_not_completion/);
    await db.query('update public.columns set automation_client_review=true where id=$1', [middle]);
    await signIn(editor);
    const sent = await move(row, middle);
    expect(sent.first_sent_at).not.toBeNull();
    await expect(db.query('update public.tasks set first_sent_at=null where id=$1', [row.id])).rejects.toThrow(/primeiro envio/);
    await signIn(owner);
    await db.exec('reset role');
    await db.query("update public.workspace_members set role='admin' where workspace_id=$1 and user_id=$2", [workspace, editor]);
    await signIn(editor);
    await expect(db.query('update public.columns set automation_client_review=false where id=$1', [middle])).rejects.toThrow(/proprietário/);
    await expect(db.query("select public.update_column_configuration_v3($1,'Alterada','#888888',false,null,false,null,null,false)", [middle])).rejects.toThrow(/proprietário/);
    await db.query("select public.update_column_configuration_v3($1,'Revisão','#888888',false,null,false,null,null,true)", [middle]);
  });

  it('movimenta apenas a tarefa escolhida e rejeita versão antiga', async () => {
    const a = await createTask('A'); const b = await createTask('B');
    const saved = await move(a, middle);
    expect(saved.column_id).toBe(middle);
    expect((await task(b.id)).updated_at).toBe(b.updated_at);
    expect((await task(b.id)).activity_at).toBe(b.activity_at);
    await expect(move(a, final)).rejects.toThrow(/mudou em outra sessão/);
    expect((await task(a.id)).column_id).toBe(middle);
  });
  it('concluir, reabrir e concluir registra custos e ganhos sem duplicar', async () => {
    let row = await createTask();
    row = await move(row, final);
    expect(row.completed_at).not.toBeNull();
    expect(await count('earnings')).toBe(1);
    expect(await count('editor_cost_entries')).toBe(1);
    row = await move(row, first);
    expect(row.completed_at).toBeNull();
    expect(await count('earnings')).toBe(0);
    expect(await count('editor_cost_entries')).toBe(0);
    await move(row, final);
    expect(await count('earnings')).toBe(1);
    expect(await count('editor_cost_entries')).toBe(1);
  });
  it('preserva finalizados e arquivados ao criar uma coluna', async () => {
    const row = await move(await createTask(), final);
    await db.query('select public.archive_completed_tasks($1)', [board]);
    await db.query("insert into public.columns(board_id,name,position) values($1,'Nova',999999)", [board]);
    const last = (await db.query<{ id: string }>('select id from public.columns where board_id=$1 order by position desc limit 1', [board])).rows[0];
    expect(last.id).toBe(final);
    expect((await task(row.id)).completed_at).toBe(row.completed_at);
    expect((await task(row.id)).archived_at).not.toBeNull();
    await expect(db.query('update public.columns set position=-1 where id=$1', [final])).rejects.toThrow(/última posição/);
    await expect(db.query('delete from public.columns where id=$1', [final])).rejects.toThrow(/preservada/);
    await db.query('select public.restore_completed_task($1)', [row.id]);
    expect((await task(row.id)).archived_at).toBeNull();
    expect(await count('earnings')).toBe(1);
  });
  it('bloqueia exclusão com histórico financeiro', async () => {
    const row = await move(await createTask(), final);
    await expect(db.query('delete from public.tasks where id=$1', [row.id])).rejects.toThrow(/histórico financeiro/);
    expect(await count('editor_cost_entries')).toBe(1);
    expect(await count('earnings')).toBe(1);
  });
  it('duplica sem datas, conclusão, bloqueio ou lançamentos e copia links opcionalmente', async () => {
    const row = await move(await createTask(), final);
    await db.query("insert into public.task_links(task_id,label,url,created_by) values($1,'Material','https://example.com',$2)", [row.id, owner]);
    const copy = (await db.query<{ row: Task }>('select to_jsonb(public.duplicate_task($1,true)) as row', [row.id])).rows[0].row;
    expect(copy.column_id).toBe(first);
    expect(copy.completed_at).toBeNull(); expect(copy.due_at).toBeNull(); expect(copy.started_at).toBeNull();
    expect(copy.archived_at).toBeNull(); expect(copy.blocked_reason).toBeNull();
    expect(await count('earnings')).toBe(1);
    expect((await db.query('select id from public.task_links where task_id=$1', [copy.id])).rows).toHaveLength(1);
    const without = (await db.query<{ row: Task }>('select to_jsonb(public.duplicate_task($1,false)) as row', [row.id])).rows[0].row;
    expect((await db.query('select id from public.task_links where task_id=$1', [without.id])).rows).toHaveLength(0);
  });
  it('respeita permissões do editor e do usuário fora da equipe', async () => {
    const row = await createTask();
    await signIn(editor);
    const moved = await move(row, middle);
    expect(moved.column_id).toBe(middle);
    await db.query("update public.tasks set blocked_reason='Aguardando material' where id=$1", [row.id]);
    await expect(db.query('select public.duplicate_task($1,false)', [row.id])).rejects.toThrow(/administradores/);
    await expect(db.query('select public.set_column_wip_limit($1,2)', [middle])).rejects.toThrow(/proprietário/);
    await expect(db.query('select public.run_all_board_automation_alerts()')).rejects.toThrow(/permission denied/);
    await signIn(outsider);
    await expect(move(moved, final)).rejects.toThrow(/acesso negado/);
  });
  it('limite de etapa é aviso e não bloqueia movimentos', async () => {
    await db.query('select public.set_column_wip_limit($1,1)', [middle]);
    await move(await createTask('A'), middle);
    await move(await createTask('B'), middle);
    expect((await db.query('select id from public.tasks where column_id=$1', [middle])).rows).toHaveLength(2);
  });

  it('mantém requisito de link e registra início uma única vez', async () => {
    await db.query("select public.update_column_configuration_v2($1,'Edição','#a78bfa',true,'download',false,null,null)", [middle]);
    const row = await createTask();
    await expect(move(row,middle)).rejects.toThrow(/Adicione um link/);
    await db.query("insert into public.task_links(task_id,label,url,created_by) values($1,'Material','https://example.com',$2)", [row.id,owner]);
    const started = await move(row,middle);
    expect(started.started_at).not.toBeNull();
    const back = await move(started,first);
    const again = await move(back,middle);
    expect(again.started_at).toBe(started.started_at);
    await expect(db.query("select public.reorder_tasks($1,'[]')", [board])).rejects.toThrow(/Atualize o EditFlow/);
  });

  it('grava configuração e limite atomicamente e rejeita valores inválidos', async () => {
    await db.query("select public.update_column_configuration_v2($1,'Em produção','#a78bfa',false,null,false,3,2)", [middle]);
    const column = (await db.query<{ name: string; wip_limit: number }>('select name,wip_limit from public.columns where id=$1', [middle])).rows[0];
    expect(column).toEqual({ name: 'Em produção', wip_limit: 2 });
    await expect(db.query("select public.update_column_configuration_v2($1,'Inválida','#a78bfa',false,null,false,3,-1)", [middle])).rejects.toThrow();
    expect((await db.query<{ name: string }>('select name from public.columns where id=$1', [middle])).rows[0].name).toBe('Em produção');
  });

  it('edição com comparação de versão não sobrescreve uma alteração posterior', async () => {
    const row = await createTask();
    await db.query("update public.tasks set title='Novo título' where id=$1", [row.id]);
    const staleUpdate = await db.query("update public.tasks set title='Antigo' where id=$1 and updated_at=$2 returning id", [row.id,row.updated_at]);
    expect(staleUpdate.rows).toHaveLength(0);
    expect((await task(row.id)).title).toBe('Novo título');
  });

  it('ordenar na mesma etapa preserva atividade real e alertas são deduplicados', async () => {
    const a = await createTask('A'); const b = await createTask('B');
    const saved = await move(a, first, b.id);
    expect(saved.activity_at).toBe(a.activity_at);
    await db.exec('reset role');
    // Seed a clock-aged task; production clients cannot forge this timestamp.
    await db.exec('alter table public.tasks disable trigger tasks_track_real_activity');
    await db.query("update public.tasks set activity_at=now()-interval '4 days' where id=$1", [a.id]);
    await db.exec('alter table public.tasks enable trigger tasks_track_real_activity');
    await db.query('update public.columns set automation_inactivity_days=3 where id=$1', [first]);
    await db.query('select public.run_all_board_automation_alerts()');
    const alerts = await db.query("select id from public.notifications where task_id=$1 and type='automation_alert'", [a.id]);
    expect(alerts.rows).toHaveLength(1);
    await db.query('select public.run_all_board_automation_alerts()');
    expect((await db.query("select id from public.notifications where task_id=$1 and type='automation_alert'", [a.id])).rows).toHaveLength(1);
    await signIn(owner);
    const updated = await move(await task(a.id), first);
    expect(updated.activity_at).toBe((await task(a.id)).activity_at);
    await db.query('select public.process_workspace_automation_alerts($1)', [workspace]);
    expect((await db.query("select id from public.notifications where task_id=$1 and type='automation_alert'", [a.id])).rows).toHaveLength(1);
  });
});
