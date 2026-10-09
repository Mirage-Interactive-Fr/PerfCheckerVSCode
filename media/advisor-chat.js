/* Requests are handled by the extension host; provider text is always rendered as text. */
function mountAdvisorChat(root, send, logo) {
  const node = (tag, text, className) => {
    const element = document.createElement(tag); if (text) element.textContent = text;
    if (className) element.className = className; return element;
  };
  const button = (label, action, className) => {
    const element = node('button', label, className); element.type = 'button'; element.addEventListener('click', action); return element;
  };
  let state = {messages: [], evidence: [], implementation: {}, busy: false}, mode = 'advice';
  const header = node('header', '', 'hero');
  if (logo) {const image = node('img'); image.src = logo; image.alt = 'PerfChecker'; header.append(image);}
  const title = node('div'); title.append(node('p', 'PERFCHECKER / ASSISTANT', 'eyebrow'), node('h1', 'From evidence to better code.'));
  const workspace = node('p', 'Workspace conversation', 'subtle'); title.append(workspace); header.append(title);
  const settings = button('Configure MCP connection', () => send({type: 'chatSettings'}), 'primary');
  const connectStdio = button('Connect local MCP server', () => send({type: 'chatConnectMcpStdio'}), 'secondary');
  const disconnectStdio = button('Disconnect local MCP server', () => send({type: 'chatDisconnectMcpStdio'}), 'secondary');
  const connectCodex = button('Connect Codex CLI', () => send({type: 'chatConnectCodex'}), 'secondary');
  const disconnectCodex = button('Disconnect Codex', () => send({type: 'chatDisconnectCodex'}), 'secondary');
  const optionalConnector = node('details', '', 'tool-settings');
  optionalConnector.append(node('summary', 'Optional Codex CLI connector'), connectCodex, disconnectCodex);
  header.append(settings, connectStdio, disconnectStdio, optionalConnector); root.append(header);
  root.append(node('p', 'Choose a server and an advice tool in MCP connection settings. Implementation uses a separately configured tool that can edit the supplied local checkout.', 'subtle'));
  const tabs = node('div', '', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Assistant mode');
  const adviceTab = button('01 · Advice', () => setMode('advice'));
  const implementationTab = button('02 · Implementation', () => setMode('implementation'));
  const modeTabs = [adviceTab, implementationTab];
  for (const [index, tab] of modeTabs.entries()) {
    tab.setAttribute('role', 'tab'); tab.id = `chat-mode-${index}`;
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % 2;
      else if (event.key === 'ArrowLeft') next = (index + 1) % 2;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 1;
      if (next !== undefined) {event.preventDefault(); setMode(next ? 'implementation' : 'advice'); modeTabs[next].focus();}
    });
  }
  tabs.append(adviceTab, implementationTab); root.append(tabs);
  const controls = node('section', '', 'context-bar');
  const evidenceLabel = node('label', 'Attach saved evidence');
  const evidence = node('select'); evidence.setAttribute('aria-label', 'Attach saved evidence'); evidenceLabel.append(evidence);
  evidence.addEventListener('change', () => send({type: 'chatClear', evidenceId: evidence.value}));
  const clear = button('New conversation', () => send({type: 'chatClear', evidenceId: evidence.value}), 'secondary');
  controls.append(evidenceLabel, clear); root.append(controls);
  const privacy = node('p', 'Messages and a short summary of the selected result are sent only when requested. The conversation stays in memory for this VS Code session.', 'subtle privacy'); root.append(privacy);
  const transcript = node('section', '', 'transcript'); transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', 'Conversation'); transcript.setAttribute('aria-live', 'polite'); root.append(transcript);
  const form = node('form', '', 'composer');
  const questionLabel = node('label', 'Ask about configuration, results or improvements');
  const question = node('textarea'); question.id = 'chat-question'; question.rows = 3; question.maxLength = 16000;
  question.placeholder = 'What should I check first to reduce allocations?'; questionLabel.htmlFor = question.id;
  const sendButton = node('button', 'Send question', 'primary'); sendButton.type = 'submit';
  const cancel = button('Cancel request', () => send({type: 'chatCancel'}), 'secondary');
  const implementationCancel = button('Cancel request', () => send({type: 'chatCancel'}), 'secondary');
  const composerActions = node('div', '', 'actions'); composerActions.append(node('span', 'Ctrl / ⌘ + Enter to send', 'subtle'), sendButton, cancel);
  form.append(questionLabel, question, composerActions); root.append(form);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (state.busy || !question.value.trim()) return;
    send({type: 'chatSend', question: question.value, evidenceId: evidence.value});
    state.busy = true; renderControls();
  });
  question.addEventListener('input', renderControls);
  question.addEventListener('keydown', event => {if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault(); form.requestSubmit();}});
  const advicePane = node('section'); advicePane.id = 'chat-advice'; advicePane.setAttribute('role', 'tabpanel'); advicePane.setAttribute('aria-labelledby', adviceTab.id);
  adviceTab.setAttribute('aria-controls', advicePane.id); advicePane.append(controls, privacy, transcript, form); root.append(advicePane);
  const implementation = node('section', '', 'implementation');
  implementation.id = 'chat-implementation'; implementation.setAttribute('role', 'tabpanel'); implementation.setAttribute('aria-labelledby', implementationTab.id);
  implementationTab.setAttribute('aria-controls', implementation.id);
  implementation.append(node('h2', 'Review. Implement. Verify.'));
  const warning = node('p', 'Agent edits may be incorrect. Git checkpoint → isolated copy → diff review → Apply. Rerun correctness and performance checks afterwards.', 'warning');
  implementation.append(warning);
  const recoveryDetails = node('details', '', 'tool-settings'); recoveryDetails.append(node('summary', 'Backup and agent access'));
  recoveryDetails.append(node('p', 'The checkpoint includes saved tracked files and non-ignored untracked files in the containing Git repository, including ignored files already staged. Save editor buffers first. Ignored untracked files, submodules, external or absolute symlinks, and custom Git content filters/LFS are not supported. HEAD and staging stay unchanged. Recovery references survive editor restarts.', 'subtle'));
  recoveryDetails.append(node('p', 'The MCP agent must be able to access and respect the supplied local checkout path. This copy is not an operating-system sandbox: a trusted agent with filesystem access may access other files. Cancellation stops the local request; the remote agent may continue.', 'subtle'));
  implementation.append(recoveryDetails);
  const reviewedAdvice = node('details', '', 'reviewed-advice'); reviewedAdvice.append(node('summary', 'Latest advice to implement'));
  const latestAdvice = node('p', '', 'message-text'); reviewedAdvice.append(latestAdvice); implementation.append(reviewedAdvice);
  const details = node('details', '', 'tool-settings'); details.append(node('summary', 'Configure the MCP implementation tool'));
  const fields = {};
  for (const [key, label, fallback] of [['tool', 'Implementation tool name', ''], ['promptArgument', 'Prompt argument', 'prompt'], ['workspaceArgument', 'Isolated workspace argument', 'workspace']]) {
    const field = node('label', label); const input = node('input'); input.value = fallback; input.setAttribute('aria-label', label); fields[key] = input; field.append(input); details.append(field);
  }
  const argumentsLabel = node('label', 'Other implementation tool arguments (JSON)');
  fields.arguments = node('textarea'); fields.arguments.rows = 3; fields.arguments.value = '{}';
  fields.arguments.setAttribute('aria-label', 'Other implementation tool arguments (JSON)');
  argumentsLabel.append(fields.arguments); details.append(argumentsLabel);
  details.append(node('p', 'Use a tool on the same MCP endpoint that can edit a supplied checkout path. Discover its name and argument schema in MCP connection settings. The tool must be able to access this filesystem.', 'subtle'));
  const saveTool = button('Save implementation tool', () => {
    try {send({type: 'implementationSettings', tool: fields.tool.value, promptArgument: fields.promptArgument.value,
      workspaceArgument: fields.workspaceArgument.value, arguments: JSON.parse(fields.arguments.value || '{}')});}
    catch {status.textContent = 'Enter valid JSON for the implementation tool arguments.';}
  }, 'secondary'); details.append(saveTool); implementation.append(details);
  const implement = button('I reviewed the advice · Prepare implementation', () => {send({type: 'chatImplement'}); state.busy = true; renderControls();}, 'primary'); implementation.append(implement);
  implementation.append(implementationCancel);
  const backup = node('p', '', 'checkpoint'); implementation.append(backup);
  const proposal = node('section', '', 'proposal');
  const summary = node('p', '', 'implementation-summary'), fileList = node('p', '', 'subtle'), patch = node('pre'); patch.setAttribute('aria-label', 'Proposed changes');
  const apply = button('Apply reviewed changes', () => {send({type: 'chatApply'}); state.busy = true; renderControls();}, 'primary');
  const restore = button('Restore previous code', () => {send({type: 'chatRestore'}); state.busy = true; renderControls();}, 'secondary');
  const fullDiff = button('Open full diff', () => send({type: 'chatDiff'}), 'secondary');
  const verify = button('Open checks and evidence', () => send({type: 'chatVerify'}), 'secondary');
  const discard = button('Discard proposal', () => send({type: 'chatDiscard'}), 'secondary');
  const proposalActions = node('div', '', 'actions'); proposalActions.append(apply, restore, fullDiff, verify, discard);
  proposal.append(node('h3', 'Implementation proposal'), summary, fileList, patch, proposalActions); implementation.append(proposal); root.append(implementation);
  const status = node('p', '', 'status'); status.setAttribute('role', 'status'); root.append(status);
  function setMode(value) {mode = value; renderControls();}
  function renderControls() {
    for (const element of [evidence, clear, settings, connectStdio, disconnectStdio, connectCodex, disconnectCodex, saveTool, ...Object.values(fields), question, discard, verify]) element.disabled = state.busy;
    connectCodex.hidden = Boolean(state.connection); disconnectCodex.hidden = !state.connection || state.connectionKind === 'stdio';
    connectStdio.hidden = Boolean(state.connection); disconnectStdio.hidden = state.connectionKind !== 'stdio';
    if (state.connection) for (const element of [saveTool, ...Object.values(fields)]) element.disabled = true;
    sendButton.disabled = state.busy || !question.value.trim(); cancel.hidden = !state.busy; implementationCancel.hidden = !state.busy;
    implementation.hidden = mode !== 'implementation';
    advicePane.hidden = mode !== 'advice';
    for (const [index, tab] of modeTabs.entries()) tab.tabIndex = (mode === 'advice' ? 0 : 1) === index ? 0 : -1;
    adviceTab.setAttribute('aria-selected', String(mode === 'advice')); implementationTab.setAttribute('aria-selected', String(mode === 'implementation'));
    implement.disabled = state.busy || !state.messages.length || !state.implementation?.tool;
    apply.disabled = state.busy || !state.proposal?.patch || state.proposal.applied;
    restore.disabled = state.busy || !state.proposal?.applied;
    fullDiff.disabled = state.busy || !state.proposal?.patch;
    proposal.hidden = !state.proposal && !state.implementationSummary;
    discard.textContent = state.proposal?.applied ? 'Keep changes · close proposal' : 'Discard proposal';
    latestAdvice.textContent = state.messages.filter(message => message.role === 'assistant').at(-1)?.content || 'Start a conversation in Advice first.';
  }
  function renderTranscript() {
    transcript.replaceChildren();
    if (!state.messages.length && !state.pending) {
      const empty = node('div', '', 'empty'); empty.append(node('h2', 'Start with a question.'), node('p', 'Explore saved evidence, understand a finding, or ask how to configure a check. Once you have reviewed the advice, switch to Implementation.'));
      transcript.append(empty);
    }
    for (const message of [...state.messages, ...(state.pending ? [{role: 'user', content: state.pending, pending: true}] : [])]) {
      const article = node('article', '', `message ${message.role}`);
      article.append(node('div', message.role === 'user' ? 'YOU' : 'ADVISOR · UNVERIFIED ADVICE', 'eyebrow'), node('div', message.content, 'message-text'));
      if (message.pending) article.append(node('small', state.busy ? 'Awaiting reply…' : 'Not sent successfully. Edit or resend your question.'));
      transcript.append(article);
    }
  }
  function receive(value) {
    if (value?.type !== 'chatState') return;
    const completed = state.busy && !value.busy && !value.pending;
    state = value;
    if (completed) question.value = '';
    workspace.textContent = `${value.workspace} · ${value.connection || 'Configured MCP conversation'}`;
    evidence.replaceChildren();
    for (const item of [{id: '', label: 'No saved evidence · usage and configuration questions'}, ...value.evidence]) {
      const option = node('option', item.label); option.value = item.id; evidence.append(option);
    }
    evidence.value = value.evidenceId;
    for (const [key, field] of Object.entries(fields)) if (document.activeElement !== field)
      field.value = key === 'arguments' ? JSON.stringify(value.implementation?.arguments ?? {}, null, 2) : value.implementation?.[key] ?? '';
    status.textContent = value.status;
    backup.textContent = value.backupRef ? `Recovery checkpoint: ${value.backupRef}` : '';
    summary.textContent = value.implementationSummary || '';
    fileList.textContent = value.proposal ? `${value.proposal.files.length} changed files · ${value.proposal.applied ? 'applied, awaiting verification' : 'awaiting review'}${value.proposal.lossyPreview ? ' · Some non-UTF8 bytes are replaced in this text preview; apply and restore preserve original bytes.' : ''}` : '';
    patch.textContent = value.proposal?.patch ? value.proposal.patch.slice(0, 120000) + (value.proposal.patch.length > 120000 ? '\n… Open the full diff to review all changes.' : '') : '';
    renderTranscript(); renderControls();
  }
  renderTranscript(); renderControls();
  return {receive};
}
if (typeof module !== 'undefined') module.exports = {mountAdvisorChat};
