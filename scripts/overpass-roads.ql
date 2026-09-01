[out:json][timeout:180];
area["name"="San Marino"]["admin_level"="2"]->.sm;
(
  way["highway"](area.sm);
  node["place"~"^(city|town|village|suburb)$"](area.sm);
  relation["boundary"="administrative"]["admin_level"="2"]["name"="San Marino"];
);
out geom;
