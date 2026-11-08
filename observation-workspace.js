/* Workspace chrome only. No meteorological calculations or additional requests. */
(() => {
  const stage=document.getElementById('chartStage'),toggle=document.getElementById('workspaceControls');
  const mobile=matchMedia('(max-width:760px)');
  const reviewTitle=document.querySelector('#chartReview > summary');
  if(reviewTitle)reviewTitle.textContent='03 / Feature review';
  function setControls(open){stage.classList.toggle('controls-hidden',!open);toggle.setAttribute('aria-expanded',String(open));toggle.textContent=open?'Hide controls':'Chart settings';}
  setControls(!mobile.matches);
  toggle.addEventListener('click',()=>setControls(stage.classList.contains('controls-hidden')));
  mobile.addEventListener('change',()=>setControls(!mobile.matches));
  stage.addEventListener('keydown',event=>{if(event.key==='Escape'&&mobile.matches&&!document.querySelector('dialog[open]')){setControls(false);toggle.focus();}});
})();
