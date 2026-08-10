// Curated "popular" list — famous, instantly-recognizable books (all public domain,
// by reliable Project Gutenberg IDs) so the homepage features real titles people
// know instead of obscure archive entries. Ordered roughly by fame. These get
// featured=1 + a high popularity so they float to the top of every ranked list.
export const CURATED = [
  { gid: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
  { gid: 84,   title: 'Frankenstein', author: 'Mary Shelley' },
  { gid: 1661, title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle' },
  { gid: 345,  title: 'Dracula', author: 'Bram Stoker' },
  { gid: 64317, title: 'The Great Gatsby', author: 'F. Scott Fitzgerald' },
  { gid: 11,   title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' },
  { gid: 2701, title: 'Moby Dick', author: 'Herman Melville' },
  { gid: 174,  title: 'The Picture of Dorian Gray', author: 'Oscar Wilde' },
  { gid: 1260, title: 'Jane Eyre', author: 'Charlotte Brontë' },
  { gid: 768,  title: 'Wuthering Heights', author: 'Emily Brontë' },
  { gid: 98,   title: 'A Tale of Two Cities', author: 'Charles Dickens' },
  { gid: 1400, title: 'Great Expectations', author: 'Charles Dickens' },
  { gid: 46,   title: 'A Christmas Carol', author: 'Charles Dickens' },
  { gid: 2554, title: 'Crime and Punishment', author: 'Fyodor Dostoyevsky' },
  { gid: 2600, title: 'War and Peace', author: 'Leo Tolstoy' },
  { gid: 1399, title: 'Anna Karenina', author: 'Leo Tolstoy' },
  { gid: 76,   title: 'Adventures of Huckleberry Finn', author: 'Mark Twain' },
  { gid: 74,   title: 'The Adventures of Tom Sawyer', author: 'Mark Twain' },
  { gid: 514,  title: 'Little Women', author: 'Louisa May Alcott' },
  { gid: 120,  title: 'Treasure Island', author: 'Robert Louis Stevenson' },
  { gid: 43,   title: 'The Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson' },
  { gid: 16,   title: 'Peter Pan', author: 'J. M. Barrie' },
  { gid: 55,   title: 'The Wonderful Wizard of Oz', author: 'L. Frank Baum' },
  { gid: 215,  title: 'The Call of the Wild', author: 'Jack London' },
  { gid: 35,   title: 'The Time Machine', author: 'H. G. Wells' },
  { gid: 36,   title: 'The War of the Worlds', author: 'H. G. Wells' },
  { gid: 5200, title: 'Metamorphosis', author: 'Franz Kafka' },
  { gid: 1727, title: 'The Odyssey', author: 'Homer' },
  { gid: 2680, title: 'Meditations', author: 'Marcus Aurelius' },
  { gid: 132,  title: 'The Art of War', author: 'Sun Tzu' },
  { gid: 158,  title: 'Emma', author: 'Jane Austen' },
  { gid: 161,  title: 'Sense and Sensibility', author: 'Jane Austen' },
  { gid: 219,  title: 'Heart of Darkness', author: 'Joseph Conrad' },
  { gid: 135,  title: 'Les Misérables', author: 'Victor Hugo' },
  { gid: 1184, title: 'The Count of Monte Cristo', author: 'Alexandre Dumas' },
  { gid: 1257, title: 'The Three Musketeers', author: 'Alexandre Dumas' },
  { gid: 996,  title: 'Don Quixote', author: 'Miguel de Cervantes' },
  { gid: 2591, title: "Grimms' Fairy Tales", author: 'Jacob & Wilhelm Grimm' },
  { gid: 1952, title: 'The Yellow Wallpaper', author: 'Charlotte Perkins Gilman' },
  { gid: 2814, title: 'Dubliners', author: 'James Joyce' },
  { gid: 203,  title: "Uncle Tom's Cabin", author: 'Harriet Beecher Stowe' },
  { gid: 25344, title: 'The Scarlet Letter', author: 'Nathaniel Hawthorne' },
  { gid: 829,  title: "Gulliver's Travels", author: 'Jonathan Swift' },
  { gid: 521,  title: 'Robinson Crusoe', author: 'Daniel Defoe' },
  { gid: 1080, title: 'A Modest Proposal', author: 'Jonathan Swift' },
  { gid: 2542, title: "A Doll's House", author: 'Henrik Ibsen' },
  { gid: 1232, title: 'The Prince', author: 'Niccolò Machiavelli' },
  { gid: 100,  title: 'The Complete Works of William Shakespeare', author: 'William Shakespeare' },
];

// Popular MODERN / recent books — acquired from Internet Archive (both ebook +
// audiobook when available). These give the catalog genuinely recent bestsellers.
export const MODERN = [
  { title: 'Atomic Habits', author: 'James Clear' },
  { title: 'The Midnight Library', author: 'Matt Haig' },
  { title: 'Where the Crawdads Sing', author: 'Delia Owens' },
  { title: 'The Silent Patient', author: 'Alex Michaelides' },
  { title: 'Educated', author: 'Tara Westover' },
  { title: 'Sapiens: A Brief History of Humankind', author: 'Yuval Noah Harari' },
  { title: 'The Seven Husbands of Evelyn Hugo', author: 'Taylor Jenkins Reid' },
  { title: 'Dune', author: 'Frank Herbert' },
  { title: 'The Song of Achilles', author: 'Madeline Miller' },
  { title: 'Circe', author: 'Madeline Miller' },
  { title: 'Project Hail Mary', author: 'Andy Weir' },
  { title: 'The Martian', author: 'Andy Weir' },
  { title: 'It Ends with Us', author: 'Colleen Hoover' },
  { title: 'Verity', author: 'Colleen Hoover' },
  { title: 'The Body Keeps the Score', author: 'Bessel van der Kolk' },
  { title: 'Thinking, Fast and Slow', author: 'Daniel Kahneman' },
  { title: 'The Subtle Art of Not Giving a F*ck', author: 'Mark Manson' },
  { title: 'Becoming', author: 'Michelle Obama' },
  { title: 'The Alchemist', author: 'Paulo Coelho' },
  { title: 'The Handmaid’s Tale', author: 'Margaret Atwood' },
  { title: '1984', author: 'George Orwell' },
  { title: 'The Kite Runner', author: 'Khaled Hosseini' },
  { title: 'Normal People', author: 'Sally Rooney' },
  { title: 'The Hunger Games', author: 'Suzanne Collins' },
  { title: 'Gone Girl', author: 'Gillian Flynn' },
  { title: 'Lessons in Chemistry', author: 'Bonnie Garmus' },
  { title: 'Tomorrow, and Tomorrow, and Tomorrow', author: 'Gabrielle Zevin' },
  { title: 'The Fault in Our Stars', author: 'John Green' },
  { title: 'A Little Life', author: 'Hanya Yanagihara' },
  { title: 'The Great Alone', author: 'Kristin Hannah' },
];

// Live "trending" from Open Library (genuinely current popularity). Returns
// normalized metadata cards (same shape as discover). Used to order/label the
// homepage; we only surface trending books we actually have in the library.
export async function openLibraryTrending(period = 'weekly') {
  const UA = 'RadicalBooks/1.0 (+https://books.theradicalparty.com)';
  try {
    const r = await fetch(`https://openlibrary.org/trending/${period}.json?limit=40`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const works = (await r.json()).works || [];
    return works.map(w => ({
      title: w.title,
      author: (w.author_name || [])[0] || (w.authors?.[0]?.name) || '',
      year: w.first_publish_year || null,
    })).filter(w => w.title);
  } catch { return []; }
}
