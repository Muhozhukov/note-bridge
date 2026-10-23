/** Debounce local bursts and limit automatic starts; manual starts bypass this. */
export function autosyncDelay(now:number,lastEdit:number,lastStart:number):number {
  return Math.max(1000,lastEdit+30000-now,lastStart+60000-now);
}
