import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { useDialogFocus } from '../lib/useDialogFocus';

type DialogOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
};

type PromptOptions = DialogOptions & {
  inputLabel: string;
  placeholder?: string;
  requiredValue?: string;
};

type DialogRequest = (
  | { kind: 'confirm'; options: DialogOptions; resolve: (result: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (result: string | null) => void }
);

export function useAppDialog() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState('');

  const close = useCallback((confirmed: boolean) => {
    setRequest((current) => {
      if (!current) return null;
      if (current.kind === 'confirm') current.resolve(confirmed);
      else current.resolve(confirmed ? inputValue.trim() : null);
      return null;
    });
  }, [inputValue]);

  const confirm = useCallback((options: DialogOptions) => new Promise<boolean>((resolve) => {
    setInputValue('');
    setRequest({ kind: 'confirm', options, resolve });
  }), []);

  const prompt = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => {
    setInputValue('');
    setRequest({ kind: 'prompt', options, resolve });
  }), []);

  const host = request ? (
    <AppDialogHost
      request={request}
      inputValue={inputValue}
      onInputValue={setInputValue}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, prompt, host, open: Boolean(request) };
}

function AppDialogHost({
  request,
  inputValue,
  onInputValue,
  onCancel,
  onConfirm,
}: {
  request: DialogRequest;
  inputValue: string;
  onInputValue: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { options } = request;
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const confirmationAllowed = request.kind === 'confirm'
    || (request.options.requiredValue
      ? inputValue.trim() === request.options.requiredValue
      : Boolean(inputValue.trim()));

  return createPortal(
    <div className="app-dialog-backdrop app-dialog-global" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section
        ref={dialogRef}
        className="app-dialog app-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-confirm-title"
        aria-describedby="app-confirm-description"
        tabIndex={-1}
      >
        <header>
          <span className={`app-dialog-icon ${options.tone === 'danger' ? 'danger' : ''}`}>
            {options.tone === 'danger' ? <AlertTriangle size={20} /> : <HelpCircle size={20} />}
          </span>
          <div>
            <p>{options.tone === 'danger' ? 'CONFIRMAR AÇÃO' : 'CONFIRMAÇÃO'}</p>
            <h2 id="app-confirm-title">{options.title}</h2>
            <small id="app-confirm-description">{options.description}</small>
          </div>
        </header>
        {request.kind === 'prompt' ? (
          <label className="app-dialog-prompt">
            <span>{request.options.inputLabel}</span>
            <input
              autoFocus
              value={inputValue}
              onChange={(event) => onInputValue(event.target.value)}
              placeholder={request.options.placeholder}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && confirmationAllowed) onConfirm();
              }}
            />
          </label>
        ) : null}
        <footer>
          <button type="button" className="app-dialog-cancel" onClick={onCancel}>{options.cancelLabel ?? 'Cancelar'}</button>
          <button type="button" className={`app-dialog-confirm ${options.tone === 'danger' ? 'danger' : ''}`} disabled={!confirmationAllowed} onClick={onConfirm}>{options.confirmLabel ?? 'Confirmar'}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
