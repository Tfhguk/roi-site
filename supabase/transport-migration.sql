begin;
alter table public.equipment drop constraint if exists equipment_type_check;
update public.equipment set type='bulldozer' where type='excavator';
alter table public.equipment add constraint equipment_type_check check(type in ('truck','bulldozer','loader','robot'));
create or replace function public.create_equipment(p_name text,p_type text) returns public.equipment
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); pid uuid; eid uuid:=gen_random_uuid(); mid int; result public.equipment;
begin
 select polygon_id into pid from public.profiles where id=uid for update;
 if uid is null or pid is null then raise exception 'Сначала выберите полигон.'; end if;
 mid:=roi_private.allocate_marker(pid,uid,'equipment',eid);
 insert into public.equipment(id,user_id,polygon_id,name,type,marker_id) values(eid,uid,pid,btrim(p_name),case when p_type='excavator' then 'bulldozer' else p_type end,mid) returning * into result;
 return result;
end $$;
create or replace function public.set_equipment_marker(p_id uuid,p_marker_id int) returns public.equipment
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); item public.equipment;
begin
 perform 1 from public.profiles where id=uid for update;
 select * into item from public.equipment where id=p_id and user_id=uid;
 if item.id is null then raise exception 'Техника не найдена.'; end if;
 if p_marker_id is null or p_marker_id not between 0 and 49 then raise exception 'Укажите целый ID от 0 до 49.'; end if;
 perform 1 from public.polygons where id=item.polygon_id for update;
 if item.marker_id=p_marker_id then return item; end if;
 if exists(select 1 from public.marker_reservations where polygon_id=item.polygon_id and marker_id=p_marker_id) then
  raise exception 'ID % уже занят в этом полигоне. Выберите другой ID.',p_marker_id;
 end if;
 update public.marker_reservations set marker_id=p_marker_id where polygon_id=item.polygon_id and owner_id=uid and purpose='equipment' and reference_id=p_id;
 if not found then raise exception 'Не найдена запись ID техники. Обновите страницу.'; end if;
 update public.equipment set marker_id=p_marker_id where id=p_id returning * into item;
 return item;
end $$;

create or replace function public.create_equipment_with_id(p_name text,p_type text,p_marker_id int default null) returns public.equipment
language plpgsql security definer set search_path='' as $$
declare item public.equipment;
begin
 item:=public.create_equipment(p_name,p_type);
 if p_marker_id is not null then item:=public.set_equipment_marker(item.id,p_marker_id); end if;
 return item;
end $$;

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

create or replace function roi_private.point_segment_distance(p jsonb,a jsonb,b jsonb) returns float8
language plpgsql immutable set search_path='' as $$
declare ax float8:=(a->>'x')::float8; ay float8:=(a->>'y')::float8; dx float8:=(b->>'x')::float8-ax; dy float8:=(b->>'y')::float8-ay; t float8:=0;
begin
 if dx*dx+dy*dy>0 then t:=greatest(0,least(1,(((p->>'x')::float8-ax)*dx+((p->>'y')::float8-ay)*dy)/(dx*dx+dy*dy))); end if;
 return sqrt(((p->>'x')::float8-ax-t*dx)^2+((p->>'y')::float8-ay-t*dy)^2);
end $$;

create or replace function roi_private.segment_distance(a jsonb,b jsonb,c jsonb,d jsonb) returns float8
language plpgsql immutable set search_path='' as $$
declare dx float8:=(b->>'x')::float8-(a->>'x')::float8; dy float8:=(b->>'y')::float8-(a->>'y')::float8;
 ex float8:=(d->>'x')::float8-(c->>'x')::float8; ey float8:=(d->>'y')::float8-(c->>'y')::float8; den float8:=dx*ey-dy*ex; t float8; u float8;
begin
 if abs(den)>0.0000001 then
  t:=(((c->>'x')::float8-(a->>'x')::float8)*ey-((c->>'y')::float8-(a->>'y')::float8)*ex)/den;
  u:=(((c->>'x')::float8-(a->>'x')::float8)*dy-((c->>'y')::float8-(a->>'y')::float8)*dx)/den;
  if t between 0 and 1 and u between 0 and 1 then return 0; end if;
 end if;
 return least(roi_private.point_segment_distance(a,c,d),roi_private.point_segment_distance(b,c,d),roi_private.point_segment_distance(c,a,b),roi_private.point_segment_distance(d,a,b));
end $$;

-- Internal seams in overlapping driving areas are not road boundaries.
create or replace function roi_private.transport_boundary(zones jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare area jsonb; other_area jsonb; a jsonb; b jsonb; c jsonb; d jsonb; sample jsonb; leftp jsonb; rightp jsonb; result jsonb:='[]'; i int; j int; k int;
 ax float8; ay float8; dx float8; dy float8; len float8; den float8; t float8; u float8; cuts float8[];
begin
 for area in select z->'points' from jsonb_array_elements(zones) z where z->>'kind'='transport' loop
  for i in 0..jsonb_array_length(area)-1 loop
   a:=area->i; b:=area->((i+1)%jsonb_array_length(area)); ax:=(a->>'x')::float8; ay:=(a->>'y')::float8; dx:=(b->>'x')::float8-ax; dy:=(b->>'y')::float8-ay; len:=sqrt(dx*dx+dy*dy); if len<0.0000001 then continue; end if; cuts:=array[0::float8,1::float8];
   for other_area in select z->'points' from jsonb_array_elements(zones) z where z->>'kind'='transport' loop
    for j in 0..jsonb_array_length(other_area)-1 loop
     c:=other_area->j; d:=other_area->((j+1)%jsonb_array_length(other_area));
     if roi_private.point_segment_distance(c,a,b)<0.0000001 then t:=(((c->>'x')::float8-ax)*dx+((c->>'y')::float8-ay)*dy)/(len*len); cuts:=array_append(cuts,greatest(0,least(1,t))); end if;
     den:=dx*((d->>'y')::float8-(c->>'y')::float8)-dy*((d->>'x')::float8-(c->>'x')::float8);
     if abs(den)>0.0000001 then
      t:=(((c->>'x')::float8-ax)*((d->>'y')::float8-(c->>'y')::float8)-((c->>'y')::float8-ay)*((d->>'x')::float8-(c->>'x')::float8))/den;
      u:=(((c->>'x')::float8-ax)*dy-((c->>'y')::float8-ay)*dx)/den;
      if t>0 and t<1 and u between 0 and 1 then cuts:=array_append(cuts,t); end if;
     end if;
    end loop;
   end loop;
   select array_agg(distinct cut.value order by cut.value) into cuts from unnest(cuts) as cut(value);
   for k in 2..array_length(cuts,1) loop
    if cuts[k]-cuts[k-1]<0.0000001 then continue; end if; t:=(cuts[k]+cuts[k-1])/2;
    leftp:=jsonb_build_object('x',ax+dx*t-dy/len*0.0001,'y',ay+dy*t+dx/len*0.0001); rightp:=jsonb_build_object('x',ax+dx*t+dy/len*0.0001,'y',ay+dy*t-dx/len*0.0001);
    if exists(select 1 from jsonb_array_elements(zones) z where z->>'kind'='transport' and roi_private.inside(leftp,z->'points')) and exists(select 1 from jsonb_array_elements(zones) z where z->>'kind'='transport' and roi_private.inside(rightp,z->'points')) then continue; end if;
    result:=result||jsonb_build_array(jsonb_build_array(jsonb_build_object('x',ax+dx*cuts[k-1],'y',ay+dy*cuts[k-1]),jsonb_build_object('x',ax+dx*cuts[k],'y',ay+dy*cuts[k])));
   end loop;
  end loop;
 end loop; return result;
end $$;

create or replace function roi_private.route_clearance_ok(route jsonb,boundary jsonb,zones jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare edge_gap float8:=coalesce((route->>'boundaryClearance')::float8,5); marker_gap float8:=coalesce((route->>'markerClearance')::float8,40);
 edges jsonb:=roi_private.transport_boundary(zones); a jsonb; b jsonb; edge jsonb; marker jsonb; i int;
begin
 if not(edge_gap between 1 and 1000 and marker_gap between 24 and 1000) then return false; end if;
 for i in 0..jsonb_array_length(boundary)-1 loop edges:=edges||jsonb_build_array(jsonb_build_array(boundary->i,boundary->((i+1)%jsonb_array_length(boundary)))); end loop;
 for i in 0..jsonb_array_length(route->'points')-2 loop
  a:=route->'points'->i; b:=route->'points'->(i+1);
  for edge in select value from jsonb_array_elements(edges) loop if roi_private.segment_distance(a,b,edge->0,edge->1)<edge_gap-0.0000001 then return false; end if; end loop;
  for marker in select value from jsonb_array_elements(boundary) union all select p.value from jsonb_array_elements(zones) z cross join lateral jsonb_array_elements(z->'points') as p(value) loop
   if roi_private.point_segment_distance(marker,a,b)<marker_gap-0.0000001 then return false; end if;
  end loop;
 end loop; return true;
exception when others then return false;
end $$;

create or replace function roi_private.vehicle_route_ok(route jsonb,vehicle_type text,zones jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare base_kind text:=case when vehicle_type='loader' then 'mining' else 'warehouse' end; endpoint jsonb;
begin
 if vehicle_type='truck' then return true; end if;
 if route->>'purpose'='haul' then return false; end if;
 for endpoint in select route->'points'->0 union all select route->'points'->(jsonb_array_length(route->'points')-1) loop
  if not exists(select 1 from jsonb_array_elements(zones) z where z->>'kind' in (base_kind,'charging') and roi_private.inside(endpoint,z->'points')) then return false; end if;
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
      not roi_private.within_transport(route->'points',ws.zones) or
      not roi_private.route_clearance_ok(route,boundary,ws.zones) or
      not roi_private.vehicle_route_ok(route,(select type from public.equipment where id=(route->>'equipmentId')::uuid),ws.zones) then raise exception 'Траектория недопустима: проверьте назначение техники, её базу, транспортную зону, отступы от границ и рукомаркеров, препятствия и глубины.'; end if;
   end loop;
   profile.registration_status:='ready';
  end if;
 else raise exception 'Выберите полигон кнопкой Далее.';
 end if;
 update public.profiles set registration_status=profile.registration_status where id=profile.id returning * into profile;
 return profile;
end $$;


revoke all on all functions in schema roi_private from public,anon,authenticated;
revoke all on function public.create_equipment_with_id(text,text,int),public.set_equipment_marker(uuid,int) from public,anon;
grant execute on function public.create_equipment_with_id(text,text,int),public.set_equipment_marker(uuid,int) to authenticated;
commit;
