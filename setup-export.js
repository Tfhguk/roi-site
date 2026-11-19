(function(global){
  "use strict";
  function download(name, data, type="application/json") {
    const url=URL.createObjectURL(new Blob([typeof data==="string"?data:JSON.stringify(data,null,2)],{type}));
    const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function markerPDF(markers) {
    const unique=[...new Map(markers.map(m=>[m.markerId,m])).values()];
    if(!unique.length)throw Error("Сначала сохраните фигуры или создайте технику на сервере: он назначит ArUco ID.");
    const doc=new jspdf.jsPDF();
    unique.forEach((marker,i)=>{
      if(i&&i%6===0)doc.addPage();
      const col=i%2,row=Math.floor(i%6/2),left=12+col*96,top=10+row*94;
      const cells=ArucoMarker.matrix(marker.markerId),size=86,cell=size/cells.length;
      doc.setFillColor(255);doc.rect(left,top,size,size,"F");doc.setFillColor(0);
      cells.forEach((line,y)=>line.forEach((bit,x)=>{if(!bit)doc.rect(left+x*cell,top+y*cell,cell,cell,"F");}));
      doc.setTextColor(0);doc.setFontSize(8);doc.text("DICT_4X4_50 / ID "+marker.markerId,left,top+89);
    });
    doc.save("polygon-markers.pdf");
  }
  global.SetupExport=Object.freeze({download,markerPDF});
})(globalThis);
