/* ==========================================================================
   KPOT To Go — Menu data
   Source: "KPot_To_Go_Express_Print_Menu" + "KPOT-Drinks-and-A-La-Carte-Menu"
   Prices in USD. Edit freely — the whole app reads from this file.
   ========================================================================== */

/* Declared with `let` (not `const`) so the owner's live menu — fetched from the
   server at runtime — can replace it. See setLiveMenu() at the bottom. */
let MENU = {
  /* ---------------------------------------------------------------------
     1) HOT POT TO GO EXPRESS — Build Your Own Bowl ($15.99, one size)
     --------------------------------------------------------------------- */
  hotpot: {
    id: 'hotpot',
    name: 'Hot Pot To Go',
    tagline: 'Build Your Own Bowl',
    kind: 'builder',
    basePrice: 15.99,
    priceLabel: '$15.99',
    steps: [
      {
        id: 'broth',
        title: 'Choose 1 Broth',
        choose: 1,
        items: [
          { n: 'Japanese Miso', emoji: '🥣' },
          { n: 'Korean Seafood', emoji: '🦐', note: 'Contains chicken and pork bone broth' },
          { n: 'Healthy Herb', emoji: '🌿', note: 'Contains chicken and pork bone broth' },
          { n: 'Szechuan Spicy', emoji: '🌶️', note: 'Contains chicken and pork bone broth', spicy: 2 },
          { n: 'Mushroom', emoji: '🍄', note: 'Vegetarian', veg: true },
          { n: 'Tomato', emoji: '🍅', note: 'Vegetarian', veg: true }
        ]
      },
      {
        id: 'noodle',
        title: 'Choose 1 Noodle',
        choose: 1,
        items: [
          { n: 'Ramen', emoji: '🍜' },
          { n: 'Vermicelli', emoji: '🍝' },
          { n: 'Udon', emoji: '🍲' },
          { n: 'Sweet Potato Noodles', emoji: '🍠' },
          { n: 'Rice Cakes', emoji: '⚪' }
        ]
      },
      {
        id: 'protein',
        title: 'Choose 1 Protein',
        choose: 1,
        items: [
          { n: 'Ribeye', emoji: '🥩' },
          { n: 'Beef Belly', emoji: '🥓' },
          { n: 'Sliced Chicken', emoji: '🍗' },
          { n: 'Sliced Pork', emoji: '🐖' },
          { n: 'Mussels', emoji: '🦪' },
          { n: 'Fried Tofu', emoji: '🟨', veg: true }
        ]
      },
      {
        id: 'topping',
        title: 'Choose 1 Topping',
        choose: 1,
        items: [
          { n: 'Chicken Dumplings (6pcs)', emoji: '🥟' },
          { n: 'Shrimp Dumplings (6pcs)', emoji: '🥟' },
          { n: 'Mini Sausages', emoji: '🌭' },
          { n: 'Fish Cakes', emoji: '🍥' },
          { n: 'Quail Eggs', emoji: '🥚' },
          { n: 'Beef Meatballs', emoji: '🧆' },
          { n: 'Crab Meat', emoji: '🦀' }
        ]
      },
      {
        id: 'veg',
        title: 'Choose 3 Vegetables',
        choose: 3,
        /* A guest may take the same vegetable more than once — e.g. 3× Corn.
           Rendered as a count badge with a "−" control, same as BBQ proteins. */
        allowDuplicates: true,
        items: [
          { n: 'Napa Cabbage', emoji: '🥬' },
          { n: 'Corn', emoji: '🌽' },
          { n: 'Spinach', emoji: '🌱' },
          { n: 'Enoki Mushrooms', emoji: '🍄' },
          { n: 'Shiitake Mushrooms', emoji: '🍄' },
          { n: 'Bok Choy', emoji: '🥬' },
          { n: 'Zucchini', emoji: '🥒' },
          { n: 'Eggplant', emoji: '🍆' },
          { n: 'Lotus Root', emoji: '🪷' }
        ]
      },
      {
        id: 'sauce',
        title: 'Choose 1 Sauce on the Side',
        choose: 1,
        items: [
          { n: 'Sweet & Spicy', emoji: '🍯' },
          { n: 'KPOT Sauce', emoji: '🏺' },
          { n: 'Gochujang', emoji: '🌶️' },
          { n: 'Yum Yum Sauce', emoji: '🥛' }
        ]
      }
    ],
    addons: [
      { id: 'combo-hotpot', n: 'Make It a Combo', d: 'Fountain Drink + 2 Spring Rolls', price: 3.99 }
    ]
  },

  /* ---------------------------------------------------------------------
     2) BBQ TO GO EXPRESS — BBQ Protein Bowls
     --------------------------------------------------------------------- */
  bbq: {
    id: 'bbq',
    name: 'BBQ To Go',
    tagline: 'BBQ Protein Bowls',
    kind: 'bbq',
    sizes: [
      // Prices confirmed: Pick 1 = $12.99, Pick 2 = $15.99, Pick 3 = $18.99
      { id: 'pick1', n: 'Pick 1 Protein', price: 12.99, picks: 1, emoji: '☝️' },
      { id: 'pick2', n: 'Pick 2 Proteins', price: 15.99, picks: 2, emoji: '✌️' },
      { id: 'pick3', n: 'Pick 3 Proteins', price: 18.99, picks: 3, emoji: '🤟' }
    ],
    comesWith: ['White Rice', 'Kimchi', 'Grilled Veggies'],
    proteins: [
      { n: 'Beef Bulgogi', emoji: '🥩' },
      { n: 'Spicy Beef Bulgogi', emoji: '🌶️', spicy: 1 },
      { n: 'Garlic Chicken', emoji: '🍗' },
      { n: 'Spicy Chicken', emoji: '🌶️', spicy: 1 },
      { n: 'Garlic Shrimp', emoji: '🦐' },
      { n: 'Sliced Beef Belly', emoji: '🥓' },
      { n: 'Smoked Garlic Pork Belly', emoji: '🥓' },
      { n: 'Spicy Pork Belly', emoji: '🌶️', spicy: 1 }
    ],
    addons: []
  },

  /* ---------------------------------------------------------------------
     3) DRINKS
     --------------------------------------------------------------------- */
  drinks: {
    id: 'drinks',
    name: 'Drinks',
    kind: 'simple',
    groups: [
      {
        id: 'fountain',
        n: 'Fountain Drinks',
        price: 2.99,
        note: 'Free refills in store',
        options: ['Pepsi', 'Pepsi Zero Sugar', 'Lemonade', 'Sweet Tea', 'Unsweet Tea', 'Orange Crush', 'Ginger Ale', 'Mtn Dew']
      },
      {
        id: 'bubbletea',
        n: 'Bubble Tea',
        price: 4.99,
        options: ['Original Black Milk Tea', 'Thai Milk Tea', 'Mango Milk Tea', 'Taro Milk Tea']
      },
      {
        id: 'fruittea',
        n: 'Fruit Teas w/ Jelly',
        price: 4.99,
        options: ['Strawberry Black Tea', 'Lychee Black Tea', 'Mango Peach Green Tea', 'Passion Fruit Green Tea']
      },
      {
        id: 'lemonade',
        n: 'Specialty Lemonades',
        price: 4.50,
        options: ['Watermelon Mint Lemonade', 'Mango Lychee Refresher', 'Classic Strawberry Lemonade', 'Classic Watermelon Lemonade']
      }
    ]
  },

  /* ---------------------------------------------------------------------
     4) A LA CARTE SIDES
     --------------------------------------------------------------------- */
  sides: {
    id: 'sides',
    name: 'A La Carte',
    kind: 'simple',
    groups: [
      {
        id: 'sides',
        n: 'Sides & Snacks',
        price: null,
        items: [
          { n: 'Korean Fried Chicken Wings (6)', price: 8.99, emoji: '🍗' },
          { n: 'Korean Fried Chicken Wings (10)', price: 12.99, emoji: '🍗' },
          { n: 'Fried Spring Rolls (2)', price: 2.99, emoji: '🥠' },
          { n: 'Chinese Donuts (4)', price: 3.99, emoji: '🍩' },
          { n: 'Sesame Balls with Red Bean Paste (6)', price: 5.99, emoji: '🟤' },
          { n: 'Fried Mochi Balls with Taro (6)', price: 5.99, emoji: '🟣' },
          { n: 'Side of Fries', price: 2.99, emoji: '🍟' },
          { n: 'Side of Sliced Pickled Radish', price: 5.99, emoji: '🥗' },
          { n: 'Side of Kimchi', price: 5.99, emoji: '🥬' },
          { n: '4 oz Soup (Broth Only)', price: 2.99, emoji: '🥣' },
          { n: 'Side of White Rice', price: 1.50, emoji: '🍚' },
          { n: 'Cheesy Corn', price: 5.99, emoji: '🌽' }
        ]
      }
    ]
  }
};

/* Category tabs shown on the menu screen */
let CATEGORIES = [
  { id: 'hotpot', n: 'Hot Pot', sub: 'Build Your Own' },
  { id: 'bbq', n: 'BBQ Bowls', sub: 'Pick 2 or 3' },
  { id: 'drinks', n: 'Drinks', sub: 'Teas & Sodas' },
  { id: 'sides', n: 'A La Carte', sub: 'Sides & Snacks' }
];

/* --------------------------------------------------------------------------
   Live menu override.

   The bundled server can hold an owner-edited menu (menu.local.json) and
   serves it at /api/menu. When the storefront finds a server it calls
   setLiveMenu() with that data, replacing the defaults above — so edits made
   in the back-office show up to guests without a redeploy.

   `let` at the top level of a classic script lives in the shared global
   lexical scope, so reassigning it here is seen by every other script
   (app.js, admin pages) that reads MENU / CATEGORIES.
   -------------------------------------------------------------------------- */
function setLiveMenu(menu, cats) {
  if (menu && typeof menu === 'object') MENU = menu;
  if (cats && Array.isArray(cats)) CATEGORIES = cats;
}
function getLiveMenu() { return { menu: MENU, categories: CATEGORIES }; }
