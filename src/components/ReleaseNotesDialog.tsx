import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Rocket, ShieldCheck, Sparkles, WandSparkles, Wrench, X } from 'lucide-react';
import { useDialogFocus } from '../lib/useDialogFocus';
import type { ReleaseNote, ReleaseNoteSectionKind } from '../lib/releaseNotes';

export function ReleaseNotesDialog({
  notes,
  initialVersion,
  onClose,
  primaryActionLabel = 'Continuar para o EditFlow',
}: {
  notes: ReleaseNote[];
  initialVersion?: string;
  onClose: () => void;
  primaryActionLabel?: string;
}) {
  const initialNote = useMemo(() => notes.find((note) => note.version === initialVersion) ?? notes[0] ?? null, [initialVersion, notes]);
  const [selectedVersion, setSelectedVersion] = useState(initialNote?.version ?? '');
  const selectedNote = notes.find((note) => note.version === selectedVersion) ?? initialNote;
  const dialogRef = useDialogFocus<HTMLElement>(Boolean(selectedNote), onClose, true, '.release-notes-dialog');

  useEffect(() => setSelectedVersion(initialNote?.version ?? ''), [initialNote?.version]);
  if (!selectedNote) return null;

  return (
    <div className="release-notes-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
        <div className="release-notes-aurora release-notes-aurora-one" />
        <div className="release-notes-aurora release-notes-aurora-two" />
        <header className="release-notes-header">
          <span className="release-notes-mark"><Sparkles size={21} /><i /></span>
          <div><p>NOVIDADES DO EDITFLOW</p><h2 id="release-notes-title">{selectedNote.title}</h2><small>{selectedNote.summary}</small></div>
          <button type="button" onClick={onClose} aria-label="Fechar novidades"><X size={18} /></button>
        </header>

        <div className={`release-notes-layout ${notes.length > 1 ? 'with-history' : ''}`}>
          {notes.length > 1 ? (
            <nav className="release-notes-versions" aria-label="Histórico de versões">
              <span>HISTÓRICO</span>
              {notes.map((note, index) => (
                <button type="button" className={note.version === selectedNote.version ? 'active' : ''} key={note.version} onClick={() => setSelectedVersion(note.version)}>
                  <i>{index === 0 ? <Sparkles size={12} /> : <CheckCircle2 size={12} />}</i>
                  <span><strong>Versão {note.version}</strong><small>{formatReleaseDate(note.date)}</small></span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </nav>
          ) : null}

          <div className="release-notes-content" key={selectedNote.version}>
            <div className="release-notes-version-heading"><span>VERSÃO {selectedNote.version}</span><time dateTime={selectedNote.date}>{formatReleaseDate(selectedNote.date)}</time></div>
            <div className="release-notes-sections">
              {selectedNote.sections.map((section) => {
                const Icon = sectionIcon(section.kind);
                return (
                  <article className={`release-note-section ${section.kind}`} key={`${selectedNote.version}:${section.title}`}>
                    <header><span><Icon size={16} /></span><strong>{section.title}</strong></header>
                    <ul>{section.items.map((item) => <li key={item}><i /><span>{item}</span></li>)}</ul>
                  </article>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="release-notes-footer">
          <span><ShieldCheck size={14} />Atualização instalada com sucesso</span>
          <button type="button" autoFocus onClick={onClose}>{primaryActionLabel}<Rocket size={15} /></button>
        </footer>
      </section>
    </div>
  );
}

function sectionIcon(kind: ReleaseNoteSectionKind) {
  if (kind === 'improved') return WandSparkles;
  if (kind === 'fixed') return Wrench;
  return Sparkles;
}

function formatReleaseDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(`${date}T12:00:00`));
}
