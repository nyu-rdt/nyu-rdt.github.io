var i = 0;
var w = 0
var word = 'Mission: Build a functioning robot for once.'
var $textBox = $('.intro')
console.log($textBox)

const typeWord = () => {
    let cur = word.charAt(i)
    i += 1
    $textBox.text($textBox.text() + cur)
    if(i < word.length) setTimeout(typeWord, 30)
}

setTimeout(typeWord, 500)