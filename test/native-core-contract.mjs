// Qualification contracts are explicit: the legacy run never lowers the normal minimum.
export const GENERAL101_TREE='00c133336911b8600d63a8d6c59ce1befc5ce690';
export const GENERAL100_TREE='7af0cc74194b953c5e998efd7523f0c5f455e395';
export function nativeCoreContract({core='general',artifact='public',stage='smoke',group='narrative',commit='',tree=''}) {
  if(!['general','candidate','general100'].includes(core))throw new Error('Choose a registered minimum, pinned candidate, or explicit General 1.0.0 compatibility campaign.');
  if(core==='general100'){
    if(artifact!=='candidate'||stage!=='focused'||group!=='general100'||commit||tree)
      throw new Error('General 1.0.0 is restricted to its separate focused candidate compatibility group without Git inputs.');
    return {mode:core,version:'1.0.0',registry:'General',tree:GENERAL100_TREE};
  }
  if(core==='general'&&(commit||tree))throw new Error('Registered Core uses General without Git source overrides.');
  if(group==='general100')throw new Error('The General 1.0.0 group requires its explicit registry contract.');
  if(core==='candidate'&&![commit,tree].every(value=>/^[a-f0-9]{40}$/.test(value)))
    throw new Error('Core candidate mode requires an immutable commit and expected Git tree.');
  return {mode:core,version:core==='candidate'||artifact==='candidate'?'1.0.1':'1.0.0',
    ...(core==='candidate'?{commit,tree}:{registry:'General',...(artifact==='candidate'?{tree:GENERAL101_TREE}:{})})};
}
