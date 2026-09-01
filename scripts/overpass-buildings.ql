[out:json][timeout:300];
area["name"="San Marino"]["admin_level"="2"]->.sm;
(
  way["building"](area.sm);
  relation["building"]["type"="multipolygon"](area.sm);
);
out geom;
