begin;
-- Check complete segments against the union of all permitted driving areas.
create or replace function roi_private.within_transport(points jsonb,zones jsonb,closed boolean default false) returns boolean
language plpgsql immutable set search_path='' as $$
declare a jsonb; b jsonb; c jsonb; d jsonb; area jsonb; i int; j int; ax float8; ay float8; dx float8; dy float8; den float8; t float8; u float8; cuts float8[]; samples float8[]; sample jsonb;
begin
 if not exists(select 1 from jsonb_array_elements(zones) z where z->>'kind'='transport') then return false; end if;
 for i in 0..jsonb_array_length(points)-(case when closed then 1 else 2 end) loop
  a:=points->i; b:=points->((i+1)%jsonb_array_length(points)); ax:=(a->>'x')::float8; ay:=(a->>'y')::float8; dx:=(b->>'x')::float8-ax; dy:=(b->>'y')::float8-ay; cuts:=array[0::float8,1::float8];
  for area in select z->'points' from jsonb_array_elements(zones) z where z->>'kind'='transport' loop
   for j in 0..jsonb_array_length(area)-1 loop
    c:=area->j; d:=area->((j+1)%jsonb_array_length(area));
    den:=dx*((d->>'y')::float8-(c->>'y')::float8)-dy*((d->>'x')::float8-(c->>'x')::float8);
    if abs(den)>0.0000001 then
     t:=(((c->>'x')::float8-ax)*((d->>'y')::float8-(c->>'y')::float8)-((c->>'y')::float8-ay)*((d->>'x')::float8-(c->>'x')::float8))/den;
     u:=(((c->>'x')::float8-ax)*dy-((c->>'y')::float8-ay)*dx)/den;
     if t>0 and t<1 and u between 0 and 1 then cuts:=array_append(cuts,t); end if;
    end if;
   end loop;
  end loop;
  select array_agg(distinct cut.value order by cut.value) into cuts from unnest(cuts) as cut(value);
  samples:=cuts; for j in 2..array_length(cuts,1) loop samples:=array_append(samples,(cuts[j-1]+cuts[j])/2); end loop;
  foreach t in array samples loop
   sample:=jsonb_build_object('x',ax+dx*t,'y',ay+dy*t);
   if not exists(select 1 from jsonb_array_elements(zones) z where z->>'kind'='transport' and roi_private.inside(sample,z->'points')) then return false; end if;
  end loop;
 end loop;
 return true;
exception when others then return false;
end $$;

create or replace function public.advance_setup() returns public.profiles
language plpgsql security definer set search_path='' as $$
declare profile public.profiles; ws public.workspaces; boundary jsonb; route jsonb; kind text; zone jsonb;
begin
 select * into profile from public.profiles where id=auth.uid() for update;
 if not found then raise exception 'Войдите в аккаунт.'; end if;
 if profile.polygon_id is null then raise exception 'Сначала создайте или выберите полигон.'; end if;
 if not exists(select 1 from public.equipment where user_id=profile.id and polygon_id=profile.polygon_id) then raise exception 'Добавьте хотя бы одну единицу техники.'; end if;
 if profile.registration_status='garage' then profile.registration_status:='zones';
 elsif profile.registration_status in ('zones','routes','ready') then
  select * into ws from public.workspaces where user_id=profile.id;
  foreach kind in array array['warehouse','charging','mining','transport'] loop
   if not exists(select 1 from jsonb_array_elements(ws.zones) z where z->>'kind'=kind) then raise exception 'Создайте все четыре типа зон.'; end if;
  end loop;
  for zone in select value from jsonb_array_elements(ws.zones) where value->>'kind'<>'transport' loop
   if not roi_private.within_transport(zone->'points',ws.zones,true) then raise exception 'Склад, зарядная станция и добыча должны находиться внутри транспортной зоны.'; end if;
  end loop;
  if profile.registration_status='zones' then profile.registration_status:='routes';
  else
   if jsonb_array_length(ws.routes)=0 then raise exception 'Создайте хотя бы одну траекторию.'; end if;
   select geometry->'points' into boundary from public.polygons where id=profile.polygon_id;
   for route in select value from jsonb_array_elements(ws.routes) loop
    if not exists(select 1 from public.equipment where id=(route->>'equipmentId')::uuid and user_id=profile.id and polygon_id=profile.polygon_id) or
      not roi_private.path_ok(route->'points',boundary,ws.depth,(route->>'maxDepth')::float8,(route->>'maxSlope')::float8) or
      not roi_private.within_transport(route->'points',ws.zones) then raise exception 'Траектория недопустима: проверьте технику, транспортную зону, препятствия и глубины.'; end if;
   end loop;
   profile.registration_status:='ready';
  end if;
 else raise exception 'Выберите полигон кнопкой Далее.';
 end if;
 update public.profiles set registration_status=profile.registration_status where id=profile.id returning * into profile;
 return profile;
end $$;


revoke all on function roi_private.within_transport(jsonb,jsonb,boolean) from public,anon,authenticated;
commit;
