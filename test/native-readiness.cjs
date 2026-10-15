// Native qualification availability, explicitly requested for the 1.0.3 campaign.
// Execution-limit, cancellation, ownership and teardown tests keep their own bounds.
const NATIVE_READINESS_MS=3600000;
const NATIVE_JOB_MINUTES=360;
const NATIVE_ACTIVITY_MINUTES=330;
const NATIVE_TECHNICAL_RESERVE_MINUTES=NATIVE_JOB_MINUTES-NATIVE_ACTIVITY_MINUTES;
const nativeReadinessPolicy=Object.freeze({availabilityMilliseconds:NATIVE_READINESS_MS,
  activityMinutes:NATIVE_ACTIVITY_MINUTES,jobMinutes:NATIVE_JOB_MINUTES,
  technicalReserveMinutes:NATIVE_TECHNICAL_RESERVE_MINUTES,
  scope:'Availability only; intentional execution limits, RPC, cancellation, ownership and teardown are unchanged',
  limitation:'The shared activity budget includes preparation and all phases; a late wait is clipped by the remaining activity budget'});
function createNativeActivityBudget({startedAt=Date.now(),now=Date.now}={}){
  if(!Number.isSafeInteger(startedAt)||startedAt<=0)throw new Error('The native activity start must be an explicit epoch');
  const deadlineAt=startedAt+NATIVE_ACTIVITY_MINUTES*60000;
  const remaining=()=>{const value=deadlineAt-now();if(value<=0){const error=new Error('The shared native infrastructure activity budget is exhausted');
    error.code='NATIVE_INFRASTRUCTURE_ACTIVITY_LIMIT';throw error;}return value;};
  return Object.freeze({startedAt,deadlineAt,remaining,timeout:(requested=NATIVE_READINESS_MS)=>Math.min(requested,remaining())});
}
// The command is delegated by the caller before arming this observation timer.
// Expiry does not signal, retry, replace or re-execute the product operation.
function waitForNativeAvailability(result,label,{timeout=NATIVE_READINESS_MS}={}){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(new Error(`${label} exceeded the one-hour native availability window`),
      {code:'NATIVE_AVAILABILITY_LIMIT'})),timeout);
    Promise.resolve(result).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
module.exports={NATIVE_READINESS_MS,NATIVE_JOB_MINUTES,NATIVE_ACTIVITY_MINUTES,nativeReadinessPolicy,createNativeActivityBudget,waitForNativeAvailability};
