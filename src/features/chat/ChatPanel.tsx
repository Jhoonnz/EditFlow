import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  Minus,
  Search,
  Send,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type {
  ChatConversation,
  ChatConversationMember,
  ChatMessage,
  WorkspaceMember,
  WorkspaceSummary,
} from '../workspace/types';

export type ChatOpenRequest = {
  token: number;
  conversationId?: string;
  memberId?: string;
};

type Props = {
  workspace: WorkspaceSummary;
  currentUserId: string;
  members: WorkspaceMember[];
  request: ChatOpenRequest | null;
  onRequestHandled: () => void;
  onUnreadChange?: (count: number) => void;
};

type ConversationView = ChatConversation & {
  participantRows: ChatConversationMember[];
  otherMember: WorkspaceMember | null;
  lastMessage: ChatMessage | null;
  unreadCount: number;
};

export function ChatPanel({ workspace, currentUserId, members, request, onRequestHandled, onUnreadChange }: Props) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [conversationMembers, setConversationMembers] = useState<ChatConversationMember[]>([]);
  const [previewMessages, setPreviewMessages] = useState<ChatMessage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const openRef = useRef(false);
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeChatOnOutsidePointer = (event: PointerEvent) => {
      if (!widgetRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeChatOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeChatOnOutsidePointer);
  }, [open]);

  const loadMessages = useCallback(async (conversationId: string, quiet = false) => {
    if (!supabase) return;
    if (!quiet) setMessagesLoading(true);
    const { data, error: messageError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(150);
    if (messageError) setError(messageError.message);
    else setMessages(((data ?? []) as ChatMessage[]).reverse());
    setMessagesLoading(false);
  }, []);

  const markConversationRead = useCallback(async (conversationId: string) => {
    if (!supabase) return;
    const readAt = new Date().toISOString();
    setConversationMembers((current) => current.map((item) => (
      item.conversation_id === conversationId && item.user_id === currentUserId
        ? { ...item, last_read_at: readAt }
        : item
    )));
    await supabase
      .from('chat_conversation_members')
      .update({ last_read_at: readAt })
      .eq('conversation_id', conversationId)
      .eq('user_id', currentUserId);
  }, [currentUserId]);

  const loadOverview = useCallback(async (quiet = false) => {
    if (!supabase) return;
    if (!quiet) setLoading(true);
    setError(null);

    const generalResult = await supabase.rpc('get_or_create_general_chat', { target_workspace: workspace.id });
    if (generalResult.error) {
      setError(chatSetupMessage(generalResult.error.message));
      setLoading(false);
      return;
    }

    const conversationResult = await supabase
      .from('chat_conversations')
      .select('*')
      .eq('workspace_id', workspace.id)
      .order('updated_at', { ascending: false });
    if (conversationResult.error) {
      setError(chatSetupMessage(conversationResult.error.message));
      setLoading(false);
      return;
    }

    const nextConversations = (conversationResult.data ?? []) as ChatConversation[];
    const ids = nextConversations.map((conversation) => conversation.id);
    if (!ids.length) {
      setConversations([]);
      setConversationMembers([]);
      setPreviewMessages([]);
      setLoading(false);
      return;
    }

    const [memberResult, messageResult] = await Promise.all([
      supabase.from('chat_conversation_members').select('*').in('conversation_id', ids),
      supabase.from('chat_messages').select('*').in('conversation_id', ids).order('created_at', { ascending: false }).limit(300),
    ]);
    const loadError = memberResult.error ?? messageResult.error;
    if (loadError) {
      setError(chatSetupMessage(loadError.message));
      setLoading(false);
      return;
    }

    setConversations(nextConversations);
    setConversationMembers((memberResult.data ?? []) as ChatConversationMember[]);
    setPreviewMessages((messageResult.data ?? []) as ChatMessage[]);
    setSelectedId((current) => {
      if (current && nextConversations.some((conversation) => conversation.id === current)) return current;
      return nextConversations.find((conversation) => conversation.kind === 'general')?.id ?? nextConversations[0]?.id ?? null;
    });
    setLoading(false);
  }, [workspace.id]);

  const scheduleOverviewReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void loadOverview(true), 120);
  }, [loadOverview]);

  useEffect(() => {
    setSelectedId(null);
    setMessages([]);
    setOpen(false);
    void loadOverview();
  }, [loadOverview, workspace.id]);

  useEffect(() => {
    if (!supabase) return;
    const realtimeClient = supabase;
    let channel: RealtimeChannel | null = realtimeClient
      .channel(`editflow-chat:${workspace.id}:${currentUserId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages', filter: `workspace_id=eq.${workspace.id}` }, (payload) => {
        scheduleOverviewReload();
        const changed = (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as Partial<ChatMessage>;
        if (changed.conversation_id === selectedIdRef.current) {
          void loadMessages(changed.conversation_id, true);
          if (openRef.current) void markConversationRead(changed.conversation_id);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_conversations', filter: `workspace_id=eq.${workspace.id}` }, scheduleOverviewReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_conversation_members', filter: `user_id=eq.${currentUserId}` }, scheduleOverviewReload)
      .subscribe();

    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      if (channel) void realtimeClient.removeChannel(channel);
      channel = null;
    };
  }, [currentUserId, loadMessages, markConversationRead, scheduleOverviewReload, workspace.id]);

  useEffect(() => {
    if (!selectedId || !open) return;
    void loadMessages(selectedId);
    void markConversationRead(selectedId);
  }, [loadMessages, markConversationRead, open, selectedId]);

  useEffect(() => {
    if (!request || !supabase) return;
    const client = supabase;
    const openRequestedConversation = async () => {
      let conversationId = request.conversationId ?? null;
      if (!conversationId && request.memberId) {
        const result = await client.rpc('open_direct_chat', {
          target_workspace: workspace.id,
          target_user: request.memberId,
        });
        if (result.error) setError(chatSetupMessage(result.error.message));
        else conversationId = result.data as string;
      }
      if (conversationId) {
        await loadOverview(true);
        setSelectedId(conversationId);
        setOpen(true);
      }
      onRequestHandled();
    };
    void openRequestedConversation();
  }, [loadOverview, onRequestHandled, request, workspace.id]);

  useEffect(() => {
    if (!open || !selectedId) return;
    window.setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 40);
  }, [messages, messagesLoading, open, selectedId]);

  const conversationViews = useMemo<ConversationView[]>(() => conversations.map((conversation) => {
    const participantRows = conversationMembers.filter((member) => member.conversation_id === conversation.id);
    const ownMembership = participantRows.find((member) => member.user_id === currentUserId);
    const otherId = participantRows.find((member) => member.user_id !== currentUserId)?.user_id;
    const conversationMessages = previewMessages.filter((message) => message.conversation_id === conversation.id);
    return {
      ...conversation,
      participantRows,
      otherMember: members.find((member) => member.user_id === otherId) ?? null,
      lastMessage: conversationMessages[0] ?? null,
      unreadCount: conversationMessages.filter((message) => (
        message.sender_id !== currentUserId
        && (!ownMembership?.last_read_at || new Date(message.created_at) > new Date(ownMembership.last_read_at))
      )).length,
    };
  }).sort((first, second) => {
    if (first.kind !== second.kind) return first.kind === 'general' ? -1 : 1;
    return new Date(second.updated_at).getTime() - new Date(first.updated_at).getTime();
  }), [conversationMembers, conversations, currentUserId, members, previewMessages]);

  const totalUnread = conversationViews.reduce((total, conversation) => total + conversation.unreadCount, 0);
  useEffect(() => onUnreadChange?.(totalUnread), [onUnreadChange, totalUnread]);

  const selectedConversation = conversationViews.find((conversation) => conversation.id === selectedId) ?? null;
  const availableMembers = members
    .filter((member) => member.user_id !== currentUserId)
    .filter((member) => `${member.display_name} ${member.email ?? ''}`.toLocaleLowerCase('pt-BR').includes(memberSearch.trim().toLocaleLowerCase('pt-BR')))
    .sort((first, second) => first.display_name.localeCompare(second.display_name, 'pt-BR'));

  const selectConversation = (conversationId: string) => {
    setSelectedId(conversationId);
    setShowMemberPicker(false);
    setComposer('');
  };

  const openDirectConversation = async (memberId: string) => {
    if (!supabase) return;
    setError(null);
    const result = await supabase.rpc('open_direct_chat', {
      target_workspace: workspace.id,
      target_user: memberId,
    });
    if (result.error) return setError(chatSetupMessage(result.error.message));
    await loadOverview(true);
    selectConversation(result.data as string);
  };

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!supabase || !selectedId || !composer.trim() || sending) return;
    setSending(true);
    setError(null);
    const body = composer.trim();
    const result = await supabase.from('chat_messages').insert({
      conversation_id: selectedId,
      workspace_id: workspace.id,
      sender_id: currentUserId,
      body,
    });
    setSending(false);
    if (result.error) return setError(chatSetupMessage(result.error.message));
    setComposer('');
    await Promise.all([loadMessages(selectedId, true), loadOverview(true)]);
    await markConversationRead(selectedId);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  return (
    <div className={`chat-widget ${open ? 'open' : ''}`} ref={widgetRef}>
      {open ? (
        <section className="chat-panel" role="dialog" aria-label="Mensagens da equipe">
          <aside className="chat-sidebar">
            <header className="chat-sidebar-header">
              <div><span><MessageCircle size={16} /></span><div><strong>Mensagens</strong><small>{totalUnread ? `${totalUnread} não lidas` : 'Tudo em dia'}</small></div></div>
              <button type="button" onClick={() => setShowMemberPicker((current) => !current)} aria-label="Nova conversa privada" title="Nova conversa"><MessageSquarePlus size={17} /></button>
            </header>

            {showMemberPicker ? (
              <section className="chat-member-picker">
                <label><Search size={14} /><input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Buscar membro..." autoFocus /></label>
                <div>
                  {availableMembers.map((member) => <button type="button" key={member.user_id} onClick={() => void openDirectConversation(member.user_id)}><MemberAvatar member={member} /><span><strong>{member.display_name}</strong><small>{availabilityLabel(member)}</small></span></button>)}
                  {!availableMembers.length ? <p>Nenhum membro encontrado.</p> : null}
                </div>
              </section>
            ) : (
              <div className="chat-conversation-list">
                {loading ? <div className="chat-list-loading"><LoaderCircle className="spinner" size={18} /></div> : null}
                {conversationViews.map((conversation, index) => (
                  <div key={conversation.id}>
                    {index === 0 ? <p className="chat-list-label">EQUIPE</p> : conversation.kind === 'direct' && conversationViews[index - 1]?.kind !== 'direct' ? <p className="chat-list-label">PRIVADAS</p> : null}
                    <button type="button" className={selectedId === conversation.id ? 'active' : ''} onClick={() => selectConversation(conversation.id)}>
                      {conversation.kind === 'general' ? <span className="chat-general-avatar"><Users size={16} /></span> : <MemberAvatar member={conversation.otherMember} />}
                      <span className="chat-conversation-copy">
                        <strong>{conversation.kind === 'general' ? 'Geral' : conversation.otherMember?.display_name ?? 'Conversa privada'}</strong>
                        <small>{conversation.lastMessage ? conversation.lastMessage.body : conversation.kind === 'general' ? 'Converse com toda a equipe' : 'Comece uma conversa'}</small>
                      </span>
                      <span className="chat-conversation-meta"><small>{conversation.lastMessage ? shortTime(conversation.lastMessage.created_at) : ''}</small>{conversation.unreadCount ? <b>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</b> : null}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <div className="chat-room">
            <header className="chat-room-header">
              <div>
                {selectedConversation?.kind === 'general' ? <span className="chat-general-avatar"><Users size={16} /></span> : <MemberAvatar member={selectedConversation?.otherMember ?? null} />}
                <span><strong>{selectedConversation?.kind === 'general' ? 'Geral' : selectedConversation?.otherMember?.display_name ?? 'Mensagens'}</strong><small>{selectedConversation?.kind === 'general' ? `${members.length} membros na equipe` : selectedConversation?.otherMember ? availabilityLabel(selectedConversation.otherMember) : 'Selecione uma conversa'}</small></span>
              </div>
              <div><button type="button" onClick={() => setOpen(false)} aria-label="Minimizar chat"><Minus size={18} /></button><button type="button" onClick={() => setOpen(false)} aria-label="Fechar chat"><X size={18} /></button></div>
            </header>

            <div className="chat-message-scroll" ref={scrollRef} role="log" aria-live="polite">
              {messagesLoading ? <div className="chat-room-loading"><LoaderCircle className="spinner" size={21} /></div> : null}
              {!messagesLoading && selectedConversation && !messages.length ? <div className="chat-empty"><span><MessageCircle size={23} /></span><strong>{selectedConversation.kind === 'general' ? 'Comece a conversa da equipe' : `Converse com ${selectedConversation.otherMember?.display_name ?? 'este membro'}`}</strong><small>As mensagens serão sincronizadas entre todos os seus dispositivos.</small></div> : null}
              {messages.map((message, index) => {
                const author = members.find((member) => member.user_id === message.sender_id) ?? null;
                const own = message.sender_id === currentUserId;
                const previous = messages[index - 1];
                const showDay = !previous || dateKey(previous.created_at) !== dateKey(message.created_at);
                const showAuthor = selectedConversation?.kind === 'general' && !own && (!previous || previous.sender_id !== message.sender_id || showDay);
                return (
                  <div key={message.id}>
                    {showDay ? <div className="chat-day-divider"><span>{dayLabel(message.created_at)}</span></div> : null}
                    <article className={`chat-message ${own ? 'own' : ''}`}>
                      {!own ? <MemberAvatar member={author} compact /> : null}
                      <div>
                        {showAuthor ? <strong className="chat-message-author">{author?.display_name ?? 'Membro'}</strong> : null}
                        <div className="chat-message-bubble">
                          <p>{renderMessageBody(message.body)}</p>
                          <span>{shortTime(message.created_at)}{message.edited_at ? ' · editada' : ''}</span>
                        </div>
                      </div>
                    </article>
                  </div>
                );
              })}
            </div>

            {error ? <div className="chat-error">{error}</div> : null}
            <form className="chat-composer" onSubmit={(event) => void submitMessage(event)}>
              <div>
                <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={selectedConversation ? `Mensagem para ${selectedConversation.kind === 'general' ? 'a equipe' : selectedConversation.otherMember?.display_name ?? 'o membro'}...` : 'Selecione uma conversa'} disabled={!selectedConversation || sending} maxLength={4000} rows={1} />
                <button type="submit" disabled={!selectedConversation || !composer.trim() || sending} aria-label="Enviar mensagem">{sending ? <LoaderCircle className="spinner" size={17} /> : <Send size={17} />}</button>
              </div>
              <small>Enter para enviar · Shift + Enter para quebrar linha</small>
            </form>
          </div>
        </section>
      ) : null}

      <button type="button" className="chat-floating-button" onClick={() => setOpen(true)} aria-label="Abrir mensagens da equipe" title="Mensagens">
        <MessageCircle size={23} />
        {totalUnread ? <span>{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
      </button>
    </div>
  );
}

function MemberAvatar({ member, compact = false }: { member: WorkspaceMember | null; compact?: boolean }) {
  return (
    <span className={`chat-member-avatar ${compact ? 'compact' : ''}`}>
      {member?.avatar_url ? <img src={member.avatar_url} alt="" /> : <b>{memberInitials(member?.display_name ?? 'Membro')}</b>}
      {member ? <i className={member.availability} /> : null}
    </span>
  );
}

function renderMessageBody(body: string) {
  const parts = body.split(/((?:https?:\/\/|www\.)[^\s<]+)/gi);
  return parts.map((part, index) => {
    if (!part.match(/^(?:https?:\/\/|www\.)/i)) return <span key={`${part}-${index}`}>{part}</span>;
    const trailingPunctuation = part.match(/[.,!?;:)\]]+$/)?.[0] ?? '';
    const label = trailingPunctuation ? part.slice(0, -trailingPunctuation.length) : part;
    const target = normalizeChatUrl(label);
    return <span key={`${part}-${index}`}><button type="button" className="chat-inline-link" onClick={() => void window.editflow.openExternal(target)}>{label}</button>{trailingPunctuation}</span>;
  });
}

function normalizeChatUrl(value: string) {
  if (/^https:\/\//i.test(value)) return value;
  if (/^http:\/\//i.test(value)) return `https://${value.slice(7)}`;
  return `https://${value}`;
}

function memberInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? 'M'}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase();
}

function availabilityLabel(member: WorkspaceMember) {
  if (member.availability === 'available') return 'Disponível';
  if (member.availability === 'busy') return 'Ocupado';
  if (member.availability === 'away') return 'Ausente';
  return 'Offline';
}

function shortTime(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(value) === dateKey(today.toISOString())) return 'Hoje';
  if (dateKey(value) === dateKey(yesterday.toISOString())) return 'Ontem';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(date);
}

function chatSetupMessage(message: string) {
  const normalized = message.toLocaleLowerCase('en-US');
  if (normalized.includes('chat_conversations') || normalized.includes('get_or_create_general_chat') || normalized.includes('schema cache')) {
    return 'O banco do chat ainda não foi ativado. Execute a migração 017_team_chat.sql no Supabase.';
  }
  return message;
}
