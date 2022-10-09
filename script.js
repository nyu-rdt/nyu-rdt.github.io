var i = 0;
var word = 'ission: Build a functioning robot for once.'; // the first character will be in the html file
var $textBox = $('.intro');
console.log($textBox);

const typeWord = () => {
    let cur = word.charAt(i);
    i += 1;
    $textBox.text($textBox.text() + cur);
    if(i < word.length) setTimeout(typeWord, 30);
}

setTimeout(typeWord, 100);