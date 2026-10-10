function mountPerfCheckerStudio(root, send, logo) {
  const node = (tag, text, className) => {const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element;};
  const hero = node('header', '', 'hero'); const image = node('img'); image.src = logo; image.alt = 'PerfChecker'; hero.append(image);
  const heading = node('div'); heading.append(node('p', 'PERFCHECKER STUDIO', 'eyebrow'), node('h1', 'Make performance visible.'), node('p', 'Measure real code. Understand the evidence. Improve with confidence.', 'subtitle')); hero.append(heading); root.append(hero);
  const workspace = node('div', '', 'workspace'); const name = node('strong', 'Choose a workspace'); const environment = node('span', '', 'subtle'); workspace.append(node('span', '●', 'dot'), name, environment); root.append(workspace);
  const warning = node('p', '', 'notice'); warning.hidden = true; root.append(warning);
  const setup=node('button','Set up workspace and create suite','secondary');setup.id='setup-workspace';setup.type='button';setup.hidden=true;setup.addEventListener('click',()=>send({type:'studioAction',action:'initialize'}));root.append(setup);
  const groups = [
    {title:'01 / Measure', description:'One workspace, from individual tests to complete feature suites.', items:[
      ['suite','Feature suite','Configure checks, targets and collectors in the visual editor.','↗'],
      ['items','Existing Julia tests','Discover TestItemRunner cases and measure them from Test Explorer.','◈'],
      ['testing','Test Explorer','Functional tests and PerfChecker measurements, with their own runners.','✓']]},
    {title:'02 / Understand', description:'Evidence you can inspect, compare and share.', items:[
      ['results','Plots & results','Distributions, allocation shares, flame graphs and version comparisons.','⌁'],
      ['investigations','Investigations','Discover scenarios, diagnose findings and compare saved measurements.','◎'],
      ['tools','Tool catalogue','Inspect available analyzers and collectors for this controller.','⊞']]},
    {title:'03 / Improve', description:'Review advice, prepare changes, then verify the result.', items:[
      ['chat','Talk to your agent','Advice and implementation through MCP, with checkpoints and diff review.','✦'],
      ['advisor','Connect an advisor','Choose an endpoint, discover tools and configure bounded investigations.','⚙'],
      ['debug','Debug Julia code','Use the Julia debugger with the selected scenario environment.','◇']]}
  ];
  for (const group of groups) {
    const section = node('section'); section.append(node('h2', group.title), node('p', group.description, 'subtle'));
    const grid = node('div', '', 'card-grid');
    for (const [action,title,description,symbol] of group.items) {
      const card = node('button', '', `card ${action === 'chat' ? 'accent' : ''}`); card.type = 'button'; card.dataset.action = action;
      card.append(node('span',symbol,'symbol'),node('h3',title),node('p',description),node('span','Open workspace →','card-link'));
      card.addEventListener('click',()=>send({type:'studioAction',action})); grid.append(card);
    }
    section.append(grid); root.append(section);
  }
  const lab = node('section', '', 'lab'); lab.append(node('h2','Your Julia workbench'),node('p','The PerfChecker terminal uses this workspace’s controller. Pluto dashboards use a separate environment and launch checks only when you click Run. The Julia extension REPL keeps the environment selected in Julia’s status bar; check it before running code.','subtle'));
  const toolbar = node('div','','toolbar');
  for (const [action,label] of [['notebook','New Pluto notebook'],['openNotebook','Open Pluto notebook'],['terminal','PerfChecker terminal'],['julia','Julia extension REPL'],['tasks','Project tasks']]) {
    const button=node('button',label,'secondary');button.type='button';button.addEventListener('click',()=>send({type:'studioAction',action}));toolbar.append(button);
  }
  lab.append(toolbar);root.append(lab);
  const status=node('p','','status');status.setAttribute('role','status');root.append(status);
  const details=node('details','','environment');details.append(node('summary','Workspace environment'));const path=node('p','','subtle');details.append(path);root.append(details);
  return {receive(value) {
    if(value?.type==='studioError'){status.textContent=value.message;return;}
    if(value?.type!=='studioState')return;
    name.textContent=value.workspace;environment.textContent=value.trusted?'Trusted workspace':'Workspace trust required for execution';path.textContent=value.project||value.problem;
    setup.hidden=!value.problem&&value.suiteAvailable;
    warning.hidden=!value.problem;warning.textContent=value.problem?'Configure a controller environment containing PerfChecker to measure, plot or start the workbench.':'';
    status.textContent=value.juliaAvailable?'Julia extension available · Pluto dashboards, Julia REPL and debugging ready.':'Pluto runs with the configured Julia executable. Install the Julia extension for its REPL and debugger.';
  }};
}
if (typeof module !== 'undefined') module.exports = {mountPerfCheckerStudio};
