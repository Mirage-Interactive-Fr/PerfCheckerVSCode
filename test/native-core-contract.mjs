// Qualification contracts are explicit: legacy compatibility never lowers the
// guided-setup version exercised by the current candidate campaign.
// Expected source identity; this constant does not assert General registration.
export const CORE110_CANDIDATE={version:'1.1.0',commit:'00e94c62a2080dba02782e451422ed98ea0b358a',tree:'2563a09e7904f19592e8f658289566e76bf93c6c'};
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
  return {mode:core,version:core==='candidate'||artifact==='candidate'?'1.1.0':'1.0.0',
    ...(core==='candidate'?{commit,tree}:{registry:'General',...(artifact==='candidate'?{tree:CORE110_CANDIDATE.tree}:{})})};
}
