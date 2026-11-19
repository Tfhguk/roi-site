function setupCloudLogin() {
  "use strict";
  const $=id=>document.getElementById(id);
  for(const id of ["loginUser","regLogin"]){const input=$(id);input.type="email";input.required=true;input.placeholder="you@example.com";input.previousElementSibling.textContent="Email";}
  $("regName").maxLength=100;
  $("loginForm").querySelector(".hint").textContent="Вход в серверный аккаунт. После входа продолжится незавершённый этап настройки.";
  $("registerForm").querySelector('button[type="submit"]').textContent="Создать аккаунт и выбрать полигон";
  function tab(register){
    $("loginForm").classList.toggle("hidden",register);$("registerForm").classList.toggle("hidden",!register);
    $("tabLogin").classList.toggle("active",!register);$("tabRegister").classList.toggle("active",register);
    $("formTitle").textContent=register?"Регистрация":"Вход";
    $("formSubtitle").textContent=register?"Начнём с создания или выбора полигона":"Ваш полигон, техника и маршруты";
  }
  $("tabLogin").onclick=()=>tab(false);$("tabRegister").onclick=()=>tab(true);
  function enter(profile){location.href=profile.registration_status==="ready"||(!AppCloud.routesEnabled&&profile.registration_status==="routes")?"welcome.html":"setup.html";}
  let busy=false;
  function handler(id,action){return async event=>{
    event.preventDefault();if(busy)return;busy=true;$(id).textContent="";
    document.querySelectorAll('button[type="submit"]').forEach(b=>b.disabled=true);
    try{await action();}catch(error){$(id).textContent=error.message;}
    finally{busy=false;document.querySelectorAll('button[type="submit"]').forEach(b=>b.disabled=false);}
  };}
  $("loginForm").onsubmit=handler("loginError",async()=>enter(await AppCloud.signIn($("loginUser").value.trim(),$("loginPass").value)));
  $("registerForm").onsubmit=handler("regError",async()=>{
    const name=$("regName").value.trim(),password=$("regPass").value;
    if(!name)throw Error("Введите имя.");
    if(password.length<6)throw Error("Пароль должен содержать не менее 6 символов.");
    if(password!==$("regPass2").value)throw Error("Пароли не совпадают.");
    const profile=await AppCloud.signUp($("regLogin").value.trim(),password,name,$("regRole").value);
    if(profile)enter(profile);
    else{$("regOk").textContent="Аккаунт создан. Подтвердите email по письму Supabase, затем войдите — откроется выбор полигона.";}
  });
  window.usersReady=Promise.resolve(true);
  if(AppCloud.session())AppCloud.me().then(enter).catch(error=>{$("loginError").textContent=error.message;});
}
