/* The browser-based pairing wizard runs on ROI Site and exports private files locally. */
(function(){
'use strict';
function open(robot){
  const url=new URL('robots-setup.html',document.baseURI);
  if(robot?.id)url.searchParams.set('robot',robot.id);
  location.href=url.href;
}
window.RobotFirmwareHelper={open};
})();
