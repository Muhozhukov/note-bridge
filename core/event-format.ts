/** Display only known numeric fields; preserve raw diagnostics in JSON exports. */
export function formatDriveMetrics(detail:string):string[]{
  try{
    const m=JSON.parse(detail);
    const number=(key:string)=>typeof m?.[key]==='number'&&Number.isFinite(m[key])&&m[key]>=0?m[key]:undefined;
    const rows:string[]=[];
    const requests=number('requests'),read=number('readBytes'),write=number('writeBytes'),time=number('elapsedMs');
    const bytes=(n:number)=>n<1024?n.toLocaleString('ru-RU')+' Б':(n/1024).toLocaleString('ru-RU',{maximumFractionDigits:1})+' КиБ';
    if(requests!==undefined)rows.push('Запросов к Drive: '+requests.toLocaleString('ru-RU'));
    if(read!==undefined)rows.push('Получено: '+bytes(read));
    if(write!==undefined)rows.push('Отправлено: '+bytes(write));
    if(time!==undefined)rows.push('Суммарное время запросов: '+(time/1000).toLocaleString('ru-RU',{maximumFractionDigits:2})+' с (не длительность синхронизации)');
    return rows.length?rows:['Подробности доступны в экспорте журнала.'];
  }catch{return ['Не удалось прочитать статистику. Исходная запись сохранена в экспорте журнала.'];}
}
