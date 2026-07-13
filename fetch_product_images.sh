#!/usr/bin/env bash
# One-time downloader: pulls the 50 product images from the current live site
# into images/products/ so the Products page is fully self-contained.
# Run this from the project root:  bash fetch_product_images.sh
set -e
mkdir -p images/products
BASE="https://m.lakhamsi.com/wp-content/uploads"
declare -a URLS=(
"2022/03/java-Peanut.png" "2022/03/Bold-Peanut-1.png" "2022/03/Balanched-Peanut-1.png"
"2022/03/in-shell-peanut.png" "2022/04/Kibbled-blanched-peanut.png"
"2022/03/natural-sesame-seeds.png" "2022/03/Hulled-sesame-seeds.png" "2022/03/Black-sesame-seeds.png"
"2022/03/castor-seed.png" "2022/03/safflower-seeds.png" "2022/03/sunflower-seeds.png"
"2022/04/oriental-seeds-1.png" "2022/03/mustard-seeds.png" "2022/04/Soyabean.png"
"2022/03/chick-peas-1.png" "2022/03/brown-chick-peas.png" "2022/03/pigeon-peas.png"
"2022/04/yellow-peas.png" "2022/04/Green-Peas.png" "2022/03/red-lentils.png"
"2022/03/green-lentils.png" "2022/03/mung-beans.png" "2022/03/black-eyed-beans-1.png"
"2022/03/Kidney-beans.png" "2022/03/black-matpe.png"
"2022/03/sourgham.png" "2022/03/wheat.png" "2022/03/rice.png" "2022/03/maize.png" "2022/03/Millet.png"
"2022/03/Cumin-seeds.png" "2022/03/coriender-seeds.png" "2022/03/feenel-seeds.png"
"2022/03/whole-chilli.png" "2022/03/Turmeric-fingers.png" "2022/04/fenugreek.png"
"2022/04/dill.png" "2022/03/chilli-Flakes-1.png" "2022/03/Turmeric-powder.png" "2022/04/chili-Powder.png"
"2022/04/mustered-oil.png" "2022/04/seasame-oil.png" "2022/04/peant-oil.png"
"2022/03/castor-oil.png" "2022/03/oil-cakes.png"
"2022/03/Brown-Raisins.png" "2022/04/brown-raisins.png" "2022/04/Black-Raisins.png"
"2022/04/Natural-gums.png" "2022/04/sugar-1.png"
)
echo "Downloading ${#URLS[@]} product images..."
for u in "${URLS[@]}"; do
  fname=$(basename "$u")
  # Special-case: the 2022/03 Brown-Raisins.png is the GOLDEN raisin image -> save distinctly
  if [ "$u" = "2022/03/Brown-Raisins.png" ]; then fname="golden-raisins.png"; fi
  curl -sSL "$BASE/$u" -o "images/products/$fname" && echo "  ok  $fname" || echo "  FAIL $fname"
done
echo "Done. Images saved to images/products/"
